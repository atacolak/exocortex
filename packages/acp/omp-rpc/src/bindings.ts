/**
 * Durable Harness-session to OMP-transcript bindings, so a resumed Harness
 * session reattaches to the transcript it already owns after a restart.
 * @module @deepseek-ai/dsh-omp-rpc/bindings
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  hydrateOmpSession,
  type OmpHydrationCursor,
  type OmpHydrationOutcome,
} from './resume.ts'

/** One persisted Harness-session binding to an OMP transcript. */
export interface OmpBinding {
  /** Session id recorded by the OMP transcript header. */
  readonly ompSessionId: string
  /** Absolute transcript path the next attachment resumes. */
  readonly path: string
  /** Working directory the OMP process was launched in. */
  readonly cwd: string
  /** OMP profile the attachment used, when one was named. */
  readonly profile?: string
  /**
   * Transcript turns a previous hydration already projected into the Harness
   * session, so a later attachment appends only the tail OMP recorded since.
   */
  readonly hydratedTurns?: number
  /** Canonical transcript entry id the last hydration consumed. */
  readonly hydratedLeafEntryId?: string
  /** Transcript byte size the last hydration consumed. */
  readonly hydratedByteOffset?: number
  /** ISO timestamp of the last successful attachment. */
  readonly updatedAt: string
}

/**
 * One pending native fork recorded when a Harness session was branched from
 * another; the first attachment copies this transcript and then drops the
 * record.
 */
export interface OmpForkBinding {
  /** Absolute parent transcript path the first attachment forks. */
  readonly forkFromPath: string
  /** Working directory of the parent transcript. */
  readonly cwd: string
  /** ISO timestamp when the branch was recorded. */
  readonly updatedAt: string
}

/** A bindings file that exists but cannot be read or understood. */
export class OmpBindingsError extends Error {
  /**
   * @param message - caller-facing explanation naming the file.
   * @param options - underlying read or parse failure.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OmpBindingsError'
  }
}

interface OmpBindingsFile {
  readonly version: 1
  readonly sessions: Readonly<Record<string, OmpBinding>>
  readonly forks: Readonly<Record<string, OmpForkBinding>>
}

const BINDINGS_VERSION = 1

const HARNESS_SESSION_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const BARE_HARNESS_SESSION_UUID = new RegExp(`^${HARNESS_SESSION_UUID}$`, 'i')
const PREFIXED_HARNESS_SESSION_UUID = new RegExp(`^session-(${HARNESS_SESSION_UUID})$`, 'i')

/**
 * Canonicalize one Harness session id so a bare OMP UUID and its
 * `session-`-prefixed twin resolve to the same bindings key.
 * @param sessionId - Harness session identity from any client or router.
 * @returns the prefixed, lowercase form for UUID identities; other ids unchanged.
 */
export function canonicalOmpHarnessSessionId(sessionId: SessionId): SessionId {
  const value = String(sessionId)
  const prefixed = PREFIXED_HARNESS_SESSION_UUID.exec(value)
  if (prefixed !== null) return SessionId(`session-${(prefixed[1] as string).toLowerCase()}`)
  if (BARE_HARNESS_SESSION_UUID.test(value)) return SessionId(`session-${value.toLowerCase()}`)
  return sessionId
}

/**
 * Resolve the default bindings file under the Harness home.
 * @param home - explicit Harness home; omitted follows `$DSH_HOME`, then `~/.dsh`.
 * @returns absolute `omp/bindings.json` path.
 */
export function defaultOmpBindingsFile(home?: string): string {
  return join(resolveDshHome(home), 'omp', 'bindings.json')
}

function bindingOf(value: unknown): OmpBinding | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.ompSessionId !== 'string' || record.ompSessionId.length === 0) return undefined
  if (typeof record.path !== 'string' || record.path.length === 0) return undefined
  if (typeof record.cwd !== 'string' || record.cwd.length === 0) return undefined
  if (typeof record.updatedAt !== 'string' || record.updatedAt.length === 0) return undefined
  if (record.profile !== undefined && (typeof record.profile !== 'string' || record.profile.length === 0)) {
    return undefined
  }
  if (record.hydratedTurns !== undefined
    && (typeof record.hydratedTurns !== 'number' || !Number.isSafeInteger(record.hydratedTurns) || record.hydratedTurns < 0)) {
    return undefined
  }
  if (record.hydratedLeafEntryId !== undefined
    && (typeof record.hydratedLeafEntryId !== 'string' || record.hydratedLeafEntryId.length === 0)) {
    return undefined
  }
  if (record.hydratedByteOffset !== undefined
    && (typeof record.hydratedByteOffset !== 'number'
      || !Number.isSafeInteger(record.hydratedByteOffset)
      || record.hydratedByteOffset < 0)) {
    return undefined
  }
  return {
    ompSessionId: record.ompSessionId,
    path: record.path,
    cwd: record.cwd,
    ...record.profile === undefined ? {} : { profile: record.profile },
    ...record.hydratedTurns === undefined ? {} : { hydratedTurns: record.hydratedTurns },
    ...record.hydratedLeafEntryId === undefined ? {} : { hydratedLeafEntryId: record.hydratedLeafEntryId },
    ...record.hydratedByteOffset === undefined ? {} : { hydratedByteOffset: record.hydratedByteOffset },
    updatedAt: record.updatedAt,
  }
}

function forkBindingOf(value: unknown): OmpForkBinding | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.forkFromPath !== 'string' || record.forkFromPath.length === 0) return undefined
  if (typeof record.cwd !== 'string' || record.cwd.length === 0) return undefined
  if (typeof record.updatedAt !== 'string' || record.updatedAt.length === 0) return undefined
  return {
    forkFromPath: record.forkFromPath,
    cwd: record.cwd,
    updatedAt: record.updatedAt,
  }
}

function bindingsFileOf(text: string, path: string): OmpBindingsFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    throw new OmpBindingsError(`OMP bindings file is not JSON: ${path}`, { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OmpBindingsError(`OMP bindings file is not a JSON object: ${path}`)
  }
  const record = parsed as Record<string, unknown>
  if (record.version !== BINDINGS_VERSION) {
    throw new OmpBindingsError(`OMP bindings file has unsupported version ${String(record.version)}: ${path}`)
  }
  if (typeof record.sessions !== 'object' || record.sessions === null || Array.isArray(record.sessions)) {
    throw new OmpBindingsError(`OMP bindings file has no sessions object: ${path}`)
  }
  const sessions: Record<string, OmpBinding> = {}
  for (const [id, value] of Object.entries(record.sessions)) {
    const binding = bindingOf(value)
    if (binding === undefined) throw new OmpBindingsError(`OMP bindings file has an invalid entry "${id}": ${path}`)
    sessions[String(canonicalOmpHarnessSessionId(SessionId(id)))] = binding
  }
  const forks: Record<string, OmpForkBinding> = {}
  if (record.forks !== undefined) {
    if (typeof record.forks !== 'object' || record.forks === null || Array.isArray(record.forks)) {
      throw new OmpBindingsError(`OMP bindings file has no forks object: ${path}`)
    }
    for (const [id, value] of Object.entries(record.forks)) {
      const fork = forkBindingOf(value)
      if (fork === undefined) throw new OmpBindingsError(`OMP bindings file has an invalid fork entry "${id}": ${path}`)
      forks[String(canonicalOmpHarnessSessionId(SessionId(id)))] = fork
    }
  }
  return { version: BINDINGS_VERSION, sessions, forks }
}

function mergeBindingCursor(existing: OmpBinding | undefined, next: OmpBinding): OmpBinding {
  if (existing === undefined || existing.ompSessionId !== next.ompSessionId) return next
  return {
    ...next,
    ...next.hydratedTurns === undefined && existing.hydratedTurns !== undefined
      ? { hydratedTurns: existing.hydratedTurns }
      : {},
    ...next.hydratedLeafEntryId === undefined && existing.hydratedLeafEntryId !== undefined
      ? { hydratedLeafEntryId: existing.hydratedLeafEntryId }
      : {},
    ...next.hydratedByteOffset === undefined && existing.hydratedByteOffset !== undefined
      ? { hydratedByteOffset: existing.hydratedByteOffset }
      : {},
  }
}

/**
 * Read and write the Harness-session to OMP-transcript map in one JSON file.
 *
 * Writes are serialized and replace the file atomically, so a crash leaves the
 * previous complete binding set rather than a half-written map.
 */
export class OmpBindings {
  private state: OmpBindingsFile | undefined
  private tail: Promise<void> = Promise.resolve()

  /**
   * @param file - absolute bindings file path.
   */
  constructor(private readonly file: string) {}

  /**
   * Read the binding for one Harness session.
   * @param id - Harness session identity.
   * @returns the binding, or undefined when the session was never attached.
   */
  async get(id: SessionId): Promise<OmpBinding | undefined> {
    await this.tail
    return (await this.load()).sessions[String(canonicalOmpHarnessSessionId(id))]
  }

  /**
   * Find the single Harness session bound to one OMP session identity.
   * @param ompSessionId - session id recorded by the OMP transcript header.
   * @returns the canonical Harness session identity and its binding, or undefined when unbound.
   */
  async findByOmpSessionId(ompSessionId: string): Promise<{ readonly sessionId: SessionId; readonly binding: OmpBinding } | undefined> {
    await this.tail
    const sessions = (await this.load()).sessions
    for (const [sessionId, binding] of Object.entries(sessions)) {
      if (binding.ompSessionId === ompSessionId) return { sessionId: SessionId(sessionId), binding }
    }
    return undefined
  }

  /**
   * Record or replace one session binding.
   *
   * One OMP session owns exactly one Harness key: an existing binding for the
   * same `ompSessionId` stays canonical, absorbs the new facts, and every
   * duplicate key is removed. Cursor fields the new binding leaves undefined
   * survive, so a plain reattach never erases hydration progress.
   * @param id - Harness session identity.
   * @param binding - OMP transcript facts to persist.
   * @returns the canonical Harness session identity the binding was stored under.
   */
  async set(id: SessionId, binding: OmpBinding): Promise<SessionId> {
    return await this.enqueue(async () => {
      const state = await this.load()
      const requested = String(canonicalOmpHarnessSessionId(id))
      let target = requested
      let existing: OmpBinding | undefined
      for (const [key, entry] of Object.entries(state.sessions)) {
        if (entry.ompSessionId !== binding.ompSessionId) continue
        target = String(canonicalOmpHarnessSessionId(SessionId(key)))
        existing = entry
        break
      }
      const sessions: Record<string, OmpBinding> = {}
      for (const [key, entry] of Object.entries(state.sessions)) {
        if (entry.ompSessionId === binding.ompSessionId
          && String(canonicalOmpHarnessSessionId(SessionId(key))) !== target) {
          continue
        }
        if (key === target) continue
        sessions[key] = entry
      }
      sessions[target] = mergeBindingCursor(existing ?? state.sessions[requested], binding)
      const next: OmpBindingsFile = {
        version: BINDINGS_VERSION,
        sessions,
        forks: state.forks,
      }
      await this.write(next)
      this.state = next
      return SessionId(target)
    })
  }

  /**
   * Forget one session binding.
   * @param id - Harness session identity.
   */
  async delete(id: SessionId): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.load()
      const key = String(canonicalOmpHarnessSessionId(id))
      if (state.sessions[key] === undefined) return
      const sessions = { ...state.sessions }
      delete sessions[key]
      const next: OmpBindingsFile = { version: BINDINGS_VERSION, sessions, forks: state.forks }
      await this.write(next)
      this.state = next
    })
  }

  /**
   * Read the pending native fork for one Branch child.
   * @param id - Harness session identity.
   * @returns the recorded parent transcript, or undefined when no branch awaits attachment.
   */
  async getFork(id: SessionId): Promise<OmpForkBinding | undefined> {
    await this.tail
    return (await this.load()).forks[String(canonicalOmpHarnessSessionId(id))]
  }

  /**
   * Record the parent transcript a Branch child forks at its first attachment.
   * @param id - Harness session identity.
   * @param fork - parent transcript facts to persist.
   */
  async setFork(id: SessionId, fork: OmpForkBinding): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.load()
      const next: OmpBindingsFile = {
        version: BINDINGS_VERSION,
        sessions: state.sessions,
        forks: { ...state.forks, [String(canonicalOmpHarnessSessionId(id))]: fork },
      }
      await this.write(next)
      this.state = next
    })
  }

  /**
   * Forget one pending native fork; other bindings and forks stay intact.
   * @param id - Harness session identity.
   */
  async deleteFork(id: SessionId): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.load()
      const key = String(canonicalOmpHarnessSessionId(id))
      if (state.forks[key] === undefined) return
      const forks = { ...state.forks }
      delete forks[key]
      const next: OmpBindingsFile = { version: BINDINGS_VERSION, sessions: state.sessions, forks }
      await this.write(next)
      this.state = next
    })
  }

  private async load(): Promise<OmpBindingsFile> {
    if (this.state !== undefined) return this.state
    const text = await readFile(this.file, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new OmpBindingsError(`cannot read OMP bindings file: ${this.file}`, { cause: error })
    })
    this.state = text === undefined
      ? { version: BINDINGS_VERSION, sessions: {}, forks: {} }
      : bindingsFileOf(text, this.file)
    return this.state
  }

  private async write(state: OmpBindingsFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(state, undefined, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.file)
    } catch (error: unknown) {
      await rm(temporary, { force: true })
      throw new OmpBindingsError(`cannot write OMP bindings file: ${this.file}`, { cause: error })
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation)
    this.tail = run.then(() => {}, () => {})
    return run
  }
}

/** One hydration pass over a bound transcript. */
export interface OmpBindingHydration {
  /** Store that receives the cursor this pass records. */
  readonly bindings: OmpBindings
  /** Live session receiving the transcript's unprojected turns. */
  readonly session: Session
  /** Transcript facts to persist alongside the cursor. */
  readonly binding: OmpBinding
  /** Cursor a previous pass recorded, when it is not already on `binding`. */
  readonly cursor?: OmpHydrationCursor
  /** false leaves the last transcript turn out because OMP is still streaming it. */
  readonly includeNewestTurn: boolean
}

/**
 * Append the turns one binding's transcript recorded after its cursor, then
 * persist the canonical leaf and byte offset a reopen resumes from.
 *
 * Every active-branch turn is admitted, so a cold open of a long transcript
 * mirrors its whole history; a later pass reads only the tail OMP appended
 * while the Harness was detached.
 * @param request - store, session, transcript facts, and the cursor to resume from.
 * @returns what this pass appended and the cursor it persisted.
 */
export async function hydrateOmpBinding(request: OmpBindingHydration): Promise<OmpHydrationOutcome> {
  const outcome = await hydrateOmpSession(
    request.session,
    request.binding.path,
    Number.POSITIVE_INFINITY,
    request.cursor ?? request.binding,
    request.includeNewestTurn,
  )
  await request.bindings.set(request.session.id, {
    ...request.binding,
    hydratedTurns: outcome.hydratedTurns,
    ...outcome.hydratedLeafEntryId === undefined ? {} : { hydratedLeafEntryId: outcome.hydratedLeafEntryId },
    ...outcome.hydratedByteOffset === undefined ? {} : { hydratedByteOffset: outcome.hydratedByteOffset },
    updatedAt: new Date().toISOString(),
  })
  return outcome
}
