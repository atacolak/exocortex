/**
 * `?exo_overlay` host routes: candidate delivery, the overlay manifest the
 * client rewrites its graph with, the transactional promote, discard, the
 * candidate SSE stream, and the post-promote verification records.
 */
import { existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs'
import path from 'node:path'

import { EVENTS_ROUTE, ROUTE_PREFIX, overlayRows } from './contract.js'
import { OverlayError } from './errors.js'
import { assertPackageName, candidateDirectory, listCandidatePackages, readBase, recordBase, runDirectory } from './runs.js'
import { normalizeMarkers } from './verify.js'

const MAX_BODY_BYTES = 64 * 1024
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SAFE_RUN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_RUNS = 100
const CONTENT_TYPES = {
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  woff2: 'font/woff2',
}

function contentTypeOf(file) {
  const extension = path.extname(file).slice(1).toLowerCase()
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...headers,
  })
  response.end(body)
}

function sendError(response, status, code, message, details = {}, headers = {}) {
  sendJson(response, status, { error: { code, message, ...(Object.keys(details).length === 0 ? {} : { details }) } }, headers)
}

function failureOf(error) {
  if (error instanceof OverlayError) {
    return { status: error.status, code: error.code, message: error.message, details: error.details }
  }
  return { status: 500, code: 'overlay-failed', message: 'overlay request failed', details: {} }
}

async function readBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new OverlayError(413, 'body-too-large', 'request body exceeds 64 KiB')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new OverlayError(400, 'invalid-json', 'request body must be JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OverlayError(400, 'invalid-json', 'request body must be a JSON object')
  }
  return parsed
}

function decodeSegments(pathname) {
  const raw = pathname.slice(ROUTE_PREFIX.length).split('/').filter(Boolean)
  try {
    return raw.map(decodeURIComponent)
  } catch {
    throw new OverlayError(400, 'invalid-path', 'overlay path has malformed percent-encoding')
  }
}

function zonesOf(bundlesRoot, pkg) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(bundlesRoot, pkg, 'package.json'), 'utf8'))
    const zones = manifest?.exocortex?.zones
    return Array.isArray(zones) ? zones.filter(zone => typeof zone === 'string') : []
  } catch {
    return []
  }
}

function liveBaseOf(request) {
  const host = request?.headers?.host
  if (typeof host !== 'string' || host === '') return undefined
  const forwarded = request.headers['x-forwarded-proto']
  const scheme = typeof forwarded === 'string' && forwarded !== '' ? forwarded.split(',')[0].trim() : 'http'
  return `${scheme}://${host}`
}

/**
 * Serve the overlay candidate surface.
 * @param options - overlay root, canonical bundles root, the promote owner, and the verification owner.
 * @returns a `connection/request` handler with the cordis-atlas `{ handle }` shape.
 */
export function createOverlayRoutes({ root, bundlesRoot, promoter, verifier, pollIntervalMs = 250, now = () => new Date().toISOString() }) {
  if (typeof promoter?.promote !== 'function') throw new TypeError('createOverlayRoutes requires a promoter')

  // Discovery is read-only. It does not record or re-anchor overlay CAS bases.
  // The filesystem remains the only authority; no shadow registry is created.
  const runsOf = () => {
    if (!existsSync(root)) return []
    const rows = []
    for (const item of readdirSync(root, { withFileTypes: true })) {
      if (!item.isDirectory() || !SAFE_RUN.test(item.name)) continue
      try {
        const directory = runDirectory(root, item.name)
        const packages = listCandidatePackages(directory)
        const stat = statSync(directory)
        rows.push({
          runId: item.name,
          packages,
          candidateCount: packages.length,
          modifiedAt: new Date(stat.mtimeMs).toISOString(),
          baseRecorded: existsSync(path.join(directory, 'base.json')),
        })
      } catch {
        // A broken partial run should not make every other candidate vanish.
        rows.push({ runId: item.name, packages: [], candidateCount: 0, modifiedAt: null, baseRecorded: false, unreadable: true })
      }
    }
    return rows.sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? '') || a.runId.localeCompare(b.runId)).slice(0, MAX_RUNS)
  }

  const manifestOf = (runId) => {
    const runDir = runDirectory(root, runId)
    if (!existsSync(runDir)) throw new OverlayError(404, 'overlay-run-missing', `overlay run ${runId} is not staged`)
    const packages = listCandidatePackages(runDir)
    if (packages.length === 0) throw new OverlayError(404, 'overlay-run-empty', `overlay run ${runId} stages no package`)
    const base = recordBase({ root, bundlesRoot, runId, packages, now })
    return {
      ok: true,
      runId,
      baseRecorded: true,
      recordedAt: base.recordedAt,
      packages: overlayRows(root, runId),
    }
  }

  const serveCandidate = (runId, pkg, file, response) => {
    const directory = candidateDirectory(root, runId, pkg)
    if (!existsSync(directory)) throw new OverlayError(404, 'candidate-missing', `overlay run ${runId} has no candidate for ${pkg}`)
    recordBase({ root, bundlesRoot, runId, packages: [pkg], now })
    const target = path.join(directory, file)
    if (!SAFE_FILE.test(file) || !existsSync(target) || !statSync(target).isFile()) {
      throw new OverlayError(404, 'candidate-missing', `overlay run ${runId} has no ${file} for ${pkg}`)
    }
    const body = readFileSync(target)
    response.writeHead(200, {
      'content-type': contentTypeOf(file),
      'cache-control': 'no-store',
      'content-length': body.length,
    })
    response.end(body)
  }

  const serveEvents = (runId, request, response) => {
    const runDir = runDirectory(root, runId)
    if (!existsSync(runDir)) throw new OverlayError(404, 'overlay-run-missing', `overlay run ${runId} is not staged`)
    const initial = overlayRows(root, runId)
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const send = (frame) => { response.write(`data: ${JSON.stringify(frame)}\n\n`) }
    send({ type: 'overlay', runId, packages: initial, at: now() })
    const known = new Map(initial.map(row => [row.id, row]))
    let lastFailure
    const pump = () => {
      let current
      try {
        current = overlayRows(root, runId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message !== lastFailure) {
          lastFailure = message
          send({ type: 'failed', message, at: now() })
        }
        return
      }
      lastFailure = undefined
      const ids = new Set()
      for (const row of current) {
        ids.add(row.id)
        const previous = known.get(row.id)
        if (previous !== undefined && previous.rev === row.rev && previous.url === row.url) continue
        known.set(row.id, row)
        send({ type: 'refreshed', id: row.id, pkg: row.pkg, rev: row.rev, url: row.url, at: now() })
      }
      for (const [id, row] of [...known]) {
        if (ids.has(id)) continue
        known.delete(id)
        send({ type: 'removed', id, pkg: row.pkg, at: now() })
      }
    }
    const timer = setInterval(pump, pollIntervalMs)
    timer.unref?.()
    let watcher
    try {
      watcher = watch(runDir, { recursive: true }, () => { pump() })
      watcher.on?.('error', () => {})
    } catch {
      watcher = undefined
    }
    const close = () => {
      clearInterval(timer)
      watcher?.close?.()
      watcher = undefined
    }
    response.on('close', close)
    response.on('error', close)
    if (typeof request?.on === 'function') request.on('close', close)
  }

  const routes = {
    manifest: { GET: (request, response, runId) => { sendJson(response, 200, manifestOf(runId)) } },
    events: { GET: (request, response, runId) => { serveEvents(runId, request, response) } },
    promote: {
      POST: async (request, response, runId) => {
        const body = await readBody(request)
        const outcome = await promoter.promote({ runId })
        const packages = outcome.packages.map(row => ({ ...row, zones: zonesOf(bundlesRoot, row.pkg) }))
        const liveBase = liveBaseOf(request)
        const markers = normalizeMarkers(body.markers)
        let verification
        try {
          const record = verifier?.enqueue?.({
            runId,
            packages,
            markers,
            liveBase,
            session: typeof body.session === 'string' && body.session !== '' ? body.session : undefined,
            requestedAt: now(),
          })
          verification = record === undefined
            ? { status: 'unavailable', detail: 'no verification owner is mounted in this host' }
            : { id: record.id, status: record.status }
        } catch (error) {
          verification = { status: 'unavailable', detail: error instanceof Error ? error.message : String(error) }
        }
        sendJson(response, 200, { ok: true, ...outcome, packages, verification })
      },
    },
    discard: {
      POST: async (request, response, runId) => {
        const report = await promoter.discard({ runId })
        sendJson(response, 200, { ok: true, ...report })
      },
    },
  }

  const verifications = (request, response, url) => {
    const pkg = url.searchParams.get('package')
    const records = typeof verifier?.list === 'function' ? verifier.list({ package: pkg === null ? undefined : pkg }) : []
    sendJson(response, 200, { ok: true, records })
  }

  return {
    runs: runsOf,
    manifest: manifestOf,
    async handle(request, response, next) {
      const url = new URL(typeof request?.url === 'string' ? request.url : '/', 'http://localhost')
      if (url.pathname !== ROUTE_PREFIX && !url.pathname.startsWith(`${ROUTE_PREFIX}/`)) {
        if (typeof next === 'function') await next()
        return false
      }
      try {
        const segments = decodeSegments(url.pathname)
        if (segments.length === 0) throw new OverlayError(404, 'not-found', 'overlay route needs a run id')
        if (segments.length === 1 && segments[0] === 'runs') {
          if ((request?.method ?? 'GET') !== 'GET') {
            sendError(response, 405, 'method-not-allowed', 'only GET is allowed', {}, { allow: 'GET' })
            return true
          }
          const runs = runsOf()
          sendJson(response, 200, { ok: true, runs, count: runs.length, limit: MAX_RUNS })
          return true
        }
        if (segments.length === 1 && segments[0] === 'verifications') {
          const route = { GET: verifications }
          const action = route[request?.method ?? 'GET']
          if (action === undefined) {
            sendError(response, 405, 'method-not-allowed', `${request?.method ?? 'GET'} is not allowed`, {}, { allow: 'GET' })
            return true
          }
          action(request, response, url)
          return true
        }
        const runId = segments[0]
        if (segments.length === 2 && Object.hasOwn(routes, segments[1])) {
          const route = routes[segments[1]]
          const method = request?.method ?? 'GET'
          const action = route[method]
          if (action === undefined) {
            sendError(response, 405, 'method-not-allowed', `${method} is not allowed`, {}, { allow: Object.keys(route).join(', ') })
            return true
          }
          await action(request, response, runId)
          return true
        }
        if (segments.length >= 3) {
          const run = runId
          const pkg = assertPackageName(segments.slice(1, -1).join('/'))
          const file = segments.at(-1)
          if ((request?.method ?? 'GET') !== 'GET') {
            sendError(response, 405, 'method-not-allowed', `${request.method} is not allowed`, {}, { allow: 'GET' })
            return true
          }
          serveCandidate(run, pkg, file, response)
          return true
        }
        throw new OverlayError(404, 'not-found', `unknown overlay route ${url.pathname}`)
      } catch (error) {
        const { status, code, message, details } = failureOf(error)
        sendError(response, status, code, message, details)
        return true
      }
    },
  }
}

export { EVENTS_ROUTE, ROUTE_PREFIX }
