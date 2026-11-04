import { lstat, readdir, readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
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

/**
 * Runtime directory where OMP publishes one socket and sidecar per session.
 * @param home - user home owning the OMP configuration root.
 * @returns `<home>/.omp/run`.
 */
export function ompRunDirectory(home: string): string {
  return join(home, '.omp', 'run')
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

function processAlive(pid: number): boolean {
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
  const sidecarPath = join(runDir, `${sessionId}.json`)
  const raw = await readFile(sidecarPath, 'utf8').catch(() => undefined)
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const record = recordOf(parsed)
  if (record === undefined) return undefined
  const pid = record.pid
  const cwd = record.cwd
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  if (record.sessionId !== sessionId) return undefined
  if (!processAlive(pid)) return undefined
  const socketPath = ompSocketPath(runDir, sessionId)
  const info = await lstat(socketPath).catch(() => undefined)
  if (info?.isSocket() !== true) return undefined
  return {
    sessionId,
    pid,
    cwd,
    socketPath,
    sidecarPath,
    ...typeof record.sessionFile !== 'string' ? {} : { sessionFile: record.sessionFile },
    ...typeof record.agent !== 'string' ? {} : { agent: record.agent },
  }
}

/**
 * Scan a run directory for OMP sessions whose socket is still attachable.
 * @param runDir - OMP run directory.
 * @returns every session whose pid is alive and whose socket still answers as a socket.
 */
export async function scanOmpRunDirectory(runDir: string): Promise<OmpSocketSession[]> {
  const entries = await readdir(runDir).catch(() => [] as string[])
  const sessions: OmpSocketSession[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const session = await readOmpSocketSession(runDir, entry.slice(0, -'.json'.length))
    if (session !== undefined) sessions.push(session)
  }
  return sessions
}

/** Options for watching one OMP run directory. */
export interface OmpRunDirectoryWatchOptions {
  readonly runDir: string
  /** Poll period; defaults to 1.5 s. */
  readonly intervalMs?: number
  /** Called once per live session per scan; callers deduplicate adoption. */
  readonly onSession: (session: OmpSocketSession) => void
}

const DEFAULT_WATCH_INTERVAL_MS = 1_500

/**
 * Poll a run directory so OMP sessions started anywhere on the machine
 * surface without a manual attach.
 *
 * The first scan runs immediately, scans never overlap, and the timer is
 * unref'd so an idle watcher cannot hold the process open.
 * @param options - directory, poll period, and per-session callback.
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
      for (const session of await scanOmpRunDirectory(options.runDir)) options.onSession(session)
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
