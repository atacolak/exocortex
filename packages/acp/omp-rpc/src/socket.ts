import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { OmpRpcClient } from './client.ts'

/** One live OMP session published on its owner-only Unix socket. */
export interface OmpSocketSession {
  readonly sessionId: string
  readonly pid: number
  readonly cwd: string
  readonly socketPath: string
  readonly sidecarPath: string
  /** Transcript the owning process reports as the active session file. */
  readonly sessionFile?: string
  /** Provider/model identity the owning process currently serves. */
  readonly agent?: string
}

/** A protocol client speaking to a live OMP session socket, plus its detach verb. */
export interface OmpSocketConnection {
  readonly client: OmpRpcClient
  readonly socketPath: string
  /** Detach only this client; the owning OMP process and its session keep running. */
  close(): void
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000

/** Environment variable that overrides the run directory OMP publishes sockets under. */
export const OMP_RUN_DIR_ENV = 'OMP_RUN_DIR'

/**
 * Runtime directory where OMP publishes one socket and sidecar per session.
 * @param home - user home owning the OMP configuration root.
 * @returns `<home>/.omp/run`.
 */
export function ompRunDirectory(home: string): string {
  return join(home, '.omp', 'run')
}

/**
 * Resolve the directory OMP publishes live session sockets under.
 * @param runDir - explicit run directory; omitted follows `$OMP_RUN_DIR`, then `<home>/.omp/run`.
 * @param home - user home owning the OMP configuration root; defaults to the process home.
 * @param env - environment carrying the `$OMP_RUN_DIR` override.
 * @returns absolute run directory.
 */
export function resolveOmpRunDirectory(
  runDir?: string,
  home?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return runDir ?? env[OMP_RUN_DIR_ENV] ?? ompRunDirectory(home ?? homedir())
}

/**
 * Endpoint one OMP session publishes under {@link ompRunDirectory}.
 * @param runDir - the run directory.
 * @param sessionId - OMP session identity.
 * @returns the socket path.
 */
export function ompSocketPath(runDir: string, sessionId: string): string {
  return join(runDir, `${sessionId}.sock`)
}

/**
 * Whether an OMP process the run directory recorded still exists.
 *
 * `process.kill(pid, 0)` proves existence without signalling, and `EPERM`
 * means the process exists under another user, so only `ESRCH` reads as dead.
 * @param pid - process id recorded in a session sidecar.
 * @returns true while the process is alive.
 */
export function ompProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value === null || typeof value !== 'object' || Array.isArray(value)
    ? undefined
    : value as Record<string, unknown>
}

/**
 * How one published OMP session stands right now.
 *
 * OMP deletes its `<sessionId>.json` sidecar first when it unloads cleanly, so
 * three states must stay apart: nothing published, a publication whose process
 * died without running its exit hook, and a live publication serving a socket.
 */
export type OmpSocketState =
  | { readonly kind: 'live'; readonly session: OmpSocketSession }
  /** No sidecar: a clean unload, an offline session, or a publication already collected. */
  | { readonly kind: 'absent' }
  /** Sidecar recorded a pid that no longer exists; the artifacts are stale. */
  | { readonly kind: 'stale'; readonly pid: number }
  /** Sidecar recorded a live pid that publishes no attachable socket. */
  | { readonly kind: 'hung'; readonly pid: number; readonly reason: string }

/** Every artifact OMP publishes for one session, in the order it removes them. */
function ompSessionArtifacts(runDir: string, sessionId: string): string[] {
  return [
    join(runDir, `${sessionId}.json`),
    ompSocketPath(runDir, sessionId),
    join(runDir, `${sessionId}.sock.bind.lock`),
  ]
}

/**
 * Read one session's publication state without mutating the run directory.
 *
 * The sidecar alone is not attachment evidence: a process killed with `SIGKILL`
 * skips the exit hook that removes the socket, the bind lock, and the sidecar,
 * so the recorded pid decides whether the artifacts are stale.
 * @param runDir - OMP run directory.
 * @param sessionId - OMP session identity to inspect.
 * @returns the publication state that decides attach, resume, or refusal.
 */
export async function probeOmpSocketSession(runDir: string, sessionId: string): Promise<OmpSocketState> {
  const sidecarPath = join(runDir, `${sessionId}.json`)
  const raw = await readFile(sidecarPath, 'utf8').catch(() => undefined)
  if (raw === undefined) return { kind: 'absent' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'absent' }
  }
  const record = recordOf(parsed)
  if (record === undefined) return { kind: 'absent' }
  const pid = record.pid
  const cwd = record.cwd
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return { kind: 'absent' }
  if (typeof cwd !== 'string' || cwd.length === 0) return { kind: 'absent' }
  if (record.sessionId !== sessionId) return { kind: 'absent' }
  if (!ompProcessAlive(pid)) return { kind: 'stale', pid }
  const socketPath = ompSocketPath(runDir, sessionId)
  const info = await stat(socketPath).catch(() => undefined)
  if (info?.isSocket() !== true) {
    return { kind: 'hung', pid, reason: `process ${String(pid)} publishes no attach socket at ${socketPath}` }
  }
  return {
    kind: 'live',
    session: {
      sessionId,
      pid,
      cwd,
      socketPath,
      sidecarPath,
      ...typeof record.sessionFile !== 'string' ? {} : { sessionFile: record.sessionFile },
      ...typeof record.agent !== 'string' ? {} : { agent: record.agent },
    },
  }
}

/**
 * Remove the artifacts a dead OMP process left behind.
 *
 * OMP unlinks the sidecar first, then the socket, then the bind lock; keeping
 * that order means a partially cleaned publication never looks attachable.
 * Only a process already proven dead may reach this call.
 * @param runDir - OMP run directory.
 * @param sessionId - OMP session whose artifacts are stale.
 */
export async function clearOmpSessionArtifacts(runDir: string, sessionId: string): Promise<void> {
  for (const path of ompSessionArtifacts(runDir, sessionId)) await rm(path, { force: true })
}

/**
 * Read one session's discovery sidecar and prove its socket is still live.
 *
 * A process that exits without running its exit hook leaves the socket and
 * lock files behind, so a sidecar alone is not attachment evidence: the
 * recorded pid must still be alive and the endpoint must still be a socket.
 * @param runDir - OMP run directory.
 * @param sessionId - OMP session identity to attach.
 * @returns the live publication, or undefined when nothing is attachable.
 */
export async function readOmpSocketSession(runDir: string, sessionId: string): Promise<OmpSocketSession | undefined> {
  const state = await probeOmpSocketSession(runDir, sessionId)
  return state.kind === 'live' ? state.session : undefined
}

/**
 * Whether a transcript belongs to the session store this instance owns.
 *
 * Both sides are resolved against the current directory first, so `..` and
 * trailing separators cannot smuggle a foreign transcript past the check, and
 * a sibling such as `/a/sessions-2` is outside `/a/sessions` rather than a
 * string prefix of it.
 * @param sessionFile - transcript path recorded by the publishing process.
 * @param sessionsRoot - transcript store this instance owns.
 * @returns true when the transcript resolves under the owned root.
 */
function ownedSessionFile(sessionFile: string, sessionsRoot: string): boolean {
  const owned = relative(sessionsRoot, sessionFile)
  return owned.length > 0 && owned !== '..' && !owned.startsWith(`..${sep}`) && !isAbsolute(owned)
}

/**
 * Scan a run directory for OMP sessions whose socket is still attachable.
 *
 * A shared run directory can carry publications from several harness
 * instances. Only a sidecar whose transcript resolves under `sessionsRoot` is
 * adopted: adopting a foreign one would bind another instance's transcript to
 * a local session. OMP writes `sessionFile` as nullable, so a sidecar that
 * records no transcript is still adopted — refusing it would drop a legitimate
 * session that simply has not written one yet.
 * @param runDir - OMP run directory.
 * @param sessionsRoot - transcript store owned by this instance.
 * @returns every owned session whose pid is alive and whose socket still answers as a socket.
 */
export async function scanOmpRunDirectory(runDir: string, sessionsRoot: string): Promise<OmpSocketSession[]> {
  const entries = await readdir(runDir).catch(() => [] as string[])
  const sessions: OmpSocketSession[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const session = await readOmpSocketSession(runDir, entry.slice(0, -'.json'.length))
    if (session === undefined) continue
    if (session.sessionFile !== undefined && !ownedSessionFile(session.sessionFile, sessionsRoot)) continue
    sessions.push(session)
  }
  return sessions
}

/** Options for watching one OMP run directory. */
export interface OmpRunDirectoryWatchOptions {
  readonly runDir: string
  /** Transcript store this instance owns; publications under any other store are ignored. */
  readonly sessionsRoot: string
  /** Poll period; defaults to 1.5 s. */
  readonly intervalMs?: number
  /** Called once per live owned session per scan; callers deduplicate adoption. */
  readonly onSession: (session: OmpSocketSession) => void
}

const DEFAULT_WATCH_INTERVAL_MS = 1_500

/**
 * Poll a run directory so OMP sessions started anywhere on the machine
 * surface without a manual attach.
 *
 * Only sessions whose transcript resolves under `sessionsRoot` are reported:
 * a run directory can be shared with another harness instance, and adopting
 * its sessions would bind a foreign transcript locally. A publication with no
 * recorded transcript is still reported, because OMP writes that field as
 * nullable.
 *
 * The first scan runs immediately, scans never overlap, and the timer is
 * unref'd so an idle watcher cannot hold the process open.
 * @param options - directory, owned transcript store, poll period, and per-session callback.
 * @returns a stop function that also cancels an in-flight scan's next tick.
 */
export function watchOmpRunDirectory(options: OmpRunDirectoryWatchOptions): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS
  let scanning = false
  let stopped = false
  const scan = async (): Promise<void> => {
    if (scanning || stopped) return
    scanning = true
    try {
      for (const session of await scanOmpRunDirectory(options.runDir, options.sessionsRoot)) options.onSession(session)
    } catch {
      return
    } finally {
      scanning = false
    }
  }
  void scan()
  const timer = setInterval(() => { void scan() }, intervalMs)
  timer.unref()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

/**
 * Attach a protocol client to one published session socket.
 *
 * The returned client has already received the connection's `ready` frame.
 * Closing it detaches only this client, exactly like a TUI closing a second
 * terminal: the owning process keeps the session and every other client.
 * @param socketPath - published socket endpoint.
 * @param timeoutMs - bound for connect plus the first protocol frame.
 * @returns the ready client and its detach verb.
 */
export async function connectOmpSocket(
  socketPath: string,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<OmpSocketConnection> {
  const socket = connect(socketPath)
  socket.setEncoding('utf8')
  const client = new OmpRpcClient({ input: socket, output: socket })
  const opened = Promise.withResolvers<OmpSocketConnection>()
  const close = (): void => { socket.destroy() }
  let settled = false
  const timer = setTimeout(() => {
    close()
    opened.reject(new Error(`OMP session socket ${socketPath} did not answer within ${String(timeoutMs)}ms`))
  }, timeoutMs)
  timer.unref()
  const settle = (error?: unknown): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    socket.off('close', onClose)
    if (error !== undefined) {
      close()
      opened.reject(error instanceof Error ? error : new Error('OMP session socket failed before announcing its protocol'))
      return
    }
    opened.resolve({ client, socketPath, close })
  }
  const onError = (error: Error): void => { settle(new Error(`cannot attach OMP session socket ${socketPath}: ${error.message}`)) }
  const onClose = (): void => { settle(new Error(`OMP session socket ${socketPath} closed before announcing its protocol`)) }
  socket.on('error', onError)
  socket.once('close', onClose)
  socket.once('connect', () => {
    client.ready.then(
      () => { settle() },
      (error: unknown) => { settle(error) },
    )
  })
  return opened.promise
}
