/**
 * Bounded post-promote verification. The promote reply never waits on the live
 * host: one probe runs at a time, records are capped, and a full queue is
 * reported on the record instead of extending the promote transaction.
 *
 * The probe checks the delivery surface, not the rendered page: it reads the
 * live boot graph, requires each promoted package at the promoted revision,
 * fetches the module the browser would execute, and requires every supplied
 * candidate marker inside it. A DOM audit cannot run inside the host process,
 * so a passing delivery check records `partial` with that reason.
 */
import { randomUUID } from 'node:crypto'

const DEFAULT_LIMIT = 64
const DEFAULT_QUEUE_LIMIT = 32
const DEFAULT_TIMEOUT_MS = 5000
const MAX_MARKERS = 16
const MAX_MARKER_LENGTH = 200
const BOOT_GRAPH = /<script>globalThis\["__DSH_BOOT__"\] = ([\s\S]*?)<\/script>/
const MAX_HOPS = 4

const DOM_REASON = 'the rendered DOM is not audited in the host process'

function cookieJar(response) {
  const headers = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(header => typeof header === 'string')
  const jar = new Map()
  for (const header of headers) {
    const pair = header.split(';')[0]
    const index = pair.indexOf('=')
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
  }
  return jar
}

async function fetchShell(liveBase, timeoutMs) {
  const cookies = new Map()
  let url = new URL(`${liveBase}/`)
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { accept: 'text/html', ...(cookie === '' ? {} : { cookie }) },
      signal: AbortSignal.timeout(timeoutMs),
    })
    for (const [name, value] of cookieJar(response)) cookies.set(name, value)
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel?.()
      if (location === null) throw new Error(`live host redirected ${response.status} without a location`)
      url = new URL(location, url)
      continue
    }
    if (!response.ok) throw new Error(`live host answered ${response.status}`)
    return { html: await response.text(), cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') }
  }
  throw new Error('the live host redirect chain did not settle')
}

async function defaultProbe({ liveBase, packages = [], markers = [], timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (typeof liveBase !== 'string' || liveBase === '') {
    throw new Error('promote was not requested through an HTTP host, so no live base is known')
  }
  const shell = await fetchShell(liveBase, timeoutMs)
  const match = BOOT_GRAPH.exec(shell.html)
  if (match === null) throw new Error('the live page carries no __DSH_BOOT__ graph')
  let graph
  try {
    graph = JSON.parse(match[1])
  } catch (error) {
    throw new Error(`the live __DSH_BOOT__ graph is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const rows = new Map((Array.isArray(graph?.entries) ? graph.entries : []).map(row => [row.id, row]))
  const wanted = markers.filter(marker => typeof marker === 'string' && marker !== '')
  const checked = []
  for (const pkg of packages) {
    const row = rows.get(pkg.id)
    if (row === undefined) throw new Error(`the live graph does not serve ${pkg.id}`)
    if (typeof pkg.rev === 'string' && pkg.rev !== '' && row.rev !== pkg.rev) {
      throw new Error(`${pkg.id} is served at rev ${String(row.rev)}, not the promoted rev ${pkg.rev}`)
    }
    if (typeof row.url !== 'string' || row.url === '') throw new Error(`the live graph row for ${pkg.id} has no url`)
    const url = new URL(row.url, `${liveBase}/`)
    const module = await fetch(url, {
      redirect: 'manual',
      headers: { accept: 'text/javascript', ...(shell.cookie === '' ? {} : { cookie: shell.cookie }) },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!module.ok) throw new Error(`${pkg.id} module answered ${module.status} at ${url.pathname}`)
    const source = await module.text()
    const missing = wanted.filter(marker => !source.includes(marker))
    if (missing.length > 0) {
      throw new Error(`${pkg.id} serves content without the promoted marker ${JSON.stringify(missing[0])}`)
    }
    checked.push({ id: pkg.id, rev: row.rev, url: `${url.pathname}${url.search}`, markers: wanted.length })
  }
  const total = checked.reduce((sum, row) => sum + row.markers, 0)
  return {
    status: 'partial',
    reason: total === 0
      ? `no candidate marker was supplied, so only delivery at the promoted revision was verified; ${DOM_REASON}`
      : `every promoted package serves its module at the promoted revision with the candidate markers; ${DOM_REASON}`,
    packages: checked,
  }
}

function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Normalize the promote caller's candidate markers into bounded distinct strings. */
export function normalizeMarkers(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  for (const marker of value) {
    if (typeof marker !== 'string') continue
    const text = marker.trim()
    if (text === '' || text.length > MAX_MARKER_LENGTH || seen.has(text)) continue
    seen.add(text)
    if (seen.size >= MAX_MARKERS) break
  }
  return [...seen]
}

/**
 * Build the verification owner the overlay routes enqueue into.
 * @param options - probe, record cap, queue cap, timeout, clock, and id source.
 * @returns `{ enqueue, list, latest, records, idle }`.
 */
export function createVerifier({
  probe = defaultProbe,
  limit = DEFAULT_LIMIT,
  queueLimit = DEFAULT_QUEUE_LIMIT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => new Date().toISOString(),
  createId = () => randomUUID(),
} = {}) {
  if (typeof probe !== 'function') throw new TypeError('createVerifier requires a probe function')
  const records = []
  const queue = []
  let active = 0
  let drainWaiters = []

  const trim = () => {
    while (records.length > limit) {
      const index = records.findIndex(record => record.status !== 'pending')
      records.splice(index === -1 ? 0 : index, 1)
    }
  }

  const finish = (record, status, detail) => {
    if (record.status !== 'pending') return false
    record.status = status
    record.verifiedAt = now()
    if (detail !== undefined) record.detail = detail
    return true
  }

  const settle = () => {
    if (active > 0 || queue.length > 0) return
    const waiters = drainWaiters
    drainWaiters = []
    for (const resolve of waiters) resolve()
  }

  const pump = () => {
    if (active > 0) return
    const next = queue.shift()
    if (next === undefined) {
      settle()
      return
    }
    active += 1
    const timer = setTimeout(() => {
      finish(next.record, 'failed', { message: `probe timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    timer.unref?.()
    Promise.resolve()
      .then(() => probe({
        liveBase: next.input.liveBase,
        packages: next.input.packages,
        markers: next.input.markers,
        runId: next.input.runId,
        timeoutMs,
      }))
      .then(
        detail => finish(next.record, detail?.status === 'partial' ? 'partial' : 'verified', detail),
        error => finish(next.record, 'failed', { message: describe(error) }),
      )
      .catch(error => finish(next.record, 'failed', { message: describe(error) }))
      .finally(() => {
        clearTimeout(timer)
        active -= 1
        pump()
      })
  }

  const enqueue = (input = {}) => {
    const record = {
      id: createId(),
      runId: input.runId,
      session: input.session,
      liveBase: input.liveBase,
      packages: Array.isArray(input.packages) ? input.packages.map(row => ({ ...row })) : [],
      markers: normalizeMarkers(input.markers),
      status: 'pending',
      requestedAt: input.requestedAt ?? now(),
    }
    records.push(record)
    trim()
    if (queue.length >= queueLimit) {
      finish(record, 'skipped', { message: `verification queue is full (${queueLimit})` })
      return record
    }
    queue.push({ record, input })
    pump()
    return record
  }

  const list = ({ package: pkg } = {}) => {
    const selected = pkg === undefined
      ? records
      : records.filter(record => record.packages.some(row => row.id === pkg))
    return selected.slice().reverse()
  }

  const latest = () => records.at(-1)

  const idle = () => {
    if (active === 0 && queue.length === 0) return Promise.resolve()
    return new Promise(resolve => { drainWaiters.push(resolve) })
  }

  return { enqueue, list, latest, idle, records: () => records.slice(), get pending() { return active + queue.length } }
}

export { defaultProbe, DOM_REASON, MAX_MARKERS, MAX_MARKER_LENGTH }
