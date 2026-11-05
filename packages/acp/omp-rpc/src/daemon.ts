import { spawn } from 'node:child_process'
import { readFile, stat, unlink } from 'node:fs/promises'

/** Idle lifetime a detached keeper grants OMP before it ends the request stream. */
export const DEFAULT_OMP_DAEMON_IDLE_TIMEOUT_MS = 60 * 60_000

/** How long a keeper waits for OMP to publish its session socket. */
export const DEFAULT_OMP_DAEMON_PUBLICATION_TIMEOUT_MS = 30_000

/**
 * Operator-facing refusal for a session whose workspace directory vanished.
 * @param cwd - workspace directory recorded by the session.
 * @returns the message shared by the open route and the daemon pre-flight.
 */
export function missingWorkspaceMessage(cwd: string): string {
  return `workspace directory ${cwd} no longer exists; relocate this session to an existing directory or forget it`
}

/** One detached session daemon request: how to start OMP and where it publishes. */
export interface OmpDaemonLaunchSpec {
  /** Executable followed by its arguments. */
  readonly argv: readonly string[]
  /** Working directory OMP starts in. */
  readonly cwd: string
  /** Environment additions layered over the keeper's own environment. */
  readonly env?: Readonly<Record<string, string>> | undefined
  /** Directory OMP publishes `<sessionId>.{json,sock}` under. */
  readonly publicationDir: string
  /** Directory the bridge watches; mirrors the publication when it differs. */
  readonly runDirectory: string
  /** File the keeper writes its proof of a live session to. */
  readonly handshakePath: string
  /** Inactivity after which the keeper ends OMP's request stream. */
  readonly idleTimeoutMs?: number | undefined
  /** How long the keeper waits for OMP's publication before failing the handshake. */
  readonly publicationTimeoutMs?: number | undefined
}

/** A live detached session: the OMP process and the socket path the bridge watches. */
export interface OmpDaemonSession {
  readonly ompSessionId: string
  readonly pid: number
  readonly socketPath: string
}

/** A detached session launch whose proof of life arrives asynchronously. */
export interface OmpDaemonLaunch {
  /** Resolves once the keeper published a live session socket. */
  readonly published: Promise<OmpDaemonSession>
  /** Remove the handshake file; never signals the detached keeper or its OMP child. */
  dispose(): Promise<void>
}

/**
 * Every process fact the keeper needs is passed as argv: the keeper is a
 * self-contained ESM program run by the same Node binary as the harness, so it
 * outlives any module graph, reload, or dev-server restart.
 */
const KEEPER_SOURCE = String.raw`
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const spec = JSON.parse(process.argv[1] ?? '{}')
const handshakePath = spec.handshakePath
const publicationDir = spec.publicationDir
const runDirectory = spec.runDirectory
const publicationTimeoutMs = spec.publicationTimeoutMs

let child
let published = false
const mirrors = []
let idle

function writeHandshake(payload) {
  const temporary = handshakePath + '.' + process.pid + '.tmp'
  return mkdir(dirname(handshakePath), { recursive: true })
    .then(() => writeFile(temporary, JSON.stringify(payload)))
    .then(() => rename(temporary, handshakePath))
}

function endAfterIdle() {
  if (child.stdin.writable) child.stdin.end()
}

function touch() {
  clearTimeout(idle)
  idle = setTimeout(endAfterIdle, spec.idleTimeoutMs)
  idle.unref()
}

async function linkMirror(target, source) {
  await mkdir(dirname(target), { recursive: true })
  const temporary = target + '.' + process.pid + '.tmp'
  await unlink(temporary).catch(() => {})
  await symlink(source, temporary)
  await rename(temporary, target)
  mirrors.push(target)
}

async function publicationOf(childPid) {
  let names
  try { names = await readdir(publicationDir) } catch { return undefined }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let record
    try { record = JSON.parse(await readFile(join(publicationDir, name), 'utf8')) } catch { continue }
    if (record === null || typeof record !== 'object' || record.pid !== childPid) continue
    const sessionId = record.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) continue
    const socketPath = join(publicationDir, sessionId + '.sock')
    const info = await stat(socketPath).catch(() => undefined)
    if (info === undefined) continue
    return { sessionId, socketPath }
  }
  return undefined
}

async function publish() {
  const deadline = Date.now() + publicationTimeoutMs
  for (;;) {
    if (published) return
    const found = await publicationOf(child.pid)
    if (found !== undefined) {
      let socketPath = found.socketPath
      if (runDirectory !== publicationDir) {
        socketPath = join(runDirectory, found.sessionId + '.sock')
        await linkMirror(socketPath, found.socketPath)
        await linkMirror(join(runDirectory, found.sessionId + '.json'), join(publicationDir, found.sessionId + '.json'))
      }
      await writeHandshake({ ompSessionId: found.sessionId, pid: child.pid, socketPath })
      published = true
      return
    }
    if (Date.now() > deadline) {
      if (child.stdin.writable) child.stdin.end()
      await writeHandshake({ error: 'OMP published no session socket within ' + String(publicationTimeoutMs) + 'ms' }).catch(() => {})
      return
    }
    await new Promise(resolve => { setTimeout(resolve, 25) })
  }
}

function start() {
  const executable = spec.argv[0]
  const environment = Object.assign({}, process.env, spec.env)
  child = spawn(executable, spec.argv.slice(1), {
    detached: false,
    stdio: ['pipe', 'pipe', 'ignore'],
    cwd: spec.cwd,
    env: environment,
  })
  idle = setTimeout(endAfterIdle, spec.idleTimeoutMs)
  idle.unref()

  let buffered = ''
  let ready = false
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    touch()
    if (ready) return
    buffered += chunk
    let at = buffered.indexOf('\n')
    while (at >= 0) {
      const line = buffered.slice(0, at)
      buffered = buffered.slice(at + 1)
      try { if (JSON.parse(line).type === 'ready') ready = true } catch {}
      at = buffered.indexOf('\n')
    }
    if (buffered.length > 1024 * 1024) buffered = ''
  })
  child.stdin.on('error', () => {})
  child.on('error', (error) => {
    clearTimeout(idle)
    void writeHandshake({ error: 'cannot start OMP in workspace ' + spec.cwd + ': ' + String(error) + '; if the workspace directory no longer exists, relocate this session to an existing directory or forget it' }).catch(() => {})
      .then(() => process.exit(0))
  })
  child.on('exit', () => {
    clearTimeout(idle)
    void (async () => {
      for (const mirror of mirrors) await unlink(mirror).catch(() => {})
      if (!published) {
        await writeHandshake({ error: 'OMP exited before publishing a session socket' }).catch(() => {})
      }
      process.exit(0)
    })()
  })
  void mkdir(publicationDir, { recursive: true })
    .then(() => publish())
    .catch((error) => writeHandshake({ error: 'cannot publish OMP session: ' + String(error) }).catch(() => {}))
}

start()
`

function daemonSessionOf(value: unknown, handshakePath: string): OmpDaemonSession {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`OMP daemon handshake ${handshakePath} is not an object`)
  }
  const record = value as Record<string, unknown>
  if (typeof record.error === 'string' && record.error.length > 0) throw new Error(record.error)
  if (typeof record.ompSessionId !== 'string' || record.ompSessionId.length === 0) {
    throw new Error(`OMP daemon handshake ${handshakePath} named no session`)
  }
  if (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0) {
    throw new Error(`OMP daemon handshake ${handshakePath} named no process`)
  }
  if (typeof record.socketPath !== 'string' || record.socketPath.length === 0) {
    throw new Error(`OMP daemon handshake ${handshakePath} named no socket`)
  }
  return { ompSessionId: record.ompSessionId, pid: record.pid, socketPath: record.socketPath }
}

/**
 * Start an OMP RPC process behind a detached keeper and wait for its session
 * socket to be published.
 *
 * The keeper owns the only pipe into OMP, so a harness restart, a plugin
 * reload, or a dev-server crash never shows OMP a closed stdin; it relays
 * nothing because the bridge talks to OMP over the published Unix socket. It
 * ends OMP's request stream only after the idle timeout, and it exits with OMP.
 * @param spec - executable, directory, environment, publication paths, and timeouts.
 * @returns the proof-of-life promise and handshake cleanup.
 */
export function launchOmpDaemon(spec: OmpDaemonLaunchSpec): OmpDaemonLaunch {
  const [executable, ...args] = spec.argv
  if (executable === undefined) throw new Error('OMP daemon launch needs an executable')
  const publicationTimeoutMs = spec.publicationTimeoutMs ?? DEFAULT_OMP_DAEMON_PUBLICATION_TIMEOUT_MS
  const { promise: published, resolve, reject } = Promise.withResolvers<OmpDaemonSession>()
  let timer: NodeJS.Timeout | undefined
  let deadline = 0
  const poll = (): void => {
    timer = undefined
    readFile(spec.handshakePath, 'utf8').then(
      (text) => {
        try {
          resolve(daemonSessionOf(JSON.parse(text), spec.handshakePath))
        } catch (error: unknown) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      },
      () => {
        if (Date.now() > deadline) {
          reject(new Error(`OMP session daemon published no handshake at ${spec.handshakePath}`))
          return
        }
        timer = setTimeout(poll, 25)
        timer.unref()
      },
    )
  }
  const fail = (error: Error): void => {
    clearTimeout(timer)
    reject(error)
  }
  const startKeeper = (): void => {
    const keeper = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        KEEPER_SOURCE,
        JSON.stringify({
          argv: [executable, ...args],
          cwd: spec.cwd,
          env: spec.env ?? {},
          publicationDir: spec.publicationDir,
          runDirectory: spec.runDirectory,
          handshakePath: spec.handshakePath,
          idleTimeoutMs: spec.idleTimeoutMs ?? DEFAULT_OMP_DAEMON_IDLE_TIMEOUT_MS,
          publicationTimeoutMs,
        }),
      ],
      { detached: true, stdio: 'ignore', cwd: spec.cwd },
    )
    keeper.on('error', (error: Error) => {
      fail(new Error(`cannot start the OMP daemon in workspace ${spec.cwd}: ${String(error)}; if the workspace directory no longer exists, relocate this session to an existing directory or forget it`))
    })
    keeper.unref()
    deadline = Date.now() + publicationTimeoutMs + 5_000
    poll()
  }
  void stat(spec.cwd).then(
    (info) => {
      if (!info.isDirectory()) {
        fail(new Error(`workspace path ${spec.cwd} is not a directory; relocate this session to an existing directory or forget it`))
        return
      }
      startKeeper()
    },
    (error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code
      fail(code === 'ENOENT' || code === 'ENOTDIR'
        ? new Error(missingWorkspaceMessage(spec.cwd))
        : new Error(`cannot read workspace directory ${spec.cwd}: ${String(error)}`))
    },
  ).catch(fail)
  return {
    published,
    async dispose(): Promise<void> {
      clearTimeout(timer)
      await unlink(spec.handshakePath).catch(() => {})
    },
  }
}
