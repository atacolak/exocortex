/**
 * Durable Harness-session to OMP-transcript bindings, so a resumed Harness
 * session reattaches to the transcript it already owns after a restart.
 * @module @deepseek-ai/dsh-omp-rpc/bindings
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

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
  return {
    ompSessionId: record.ompSessionId,
    path: record.path,
    cwd: record.cwd,
    ...record.profile === undefined ? {} : { profile: record.profile },
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
    sessions[id] = binding
  }
  const forks: Record<string, OmpForkBinding> = {}
  if (record.forks !== undefined) {
    if (typeof record.forks !== 'object' || record.forks === null || Array.isArray(record.forks)) {
      throw new OmpBindingsError(`OMP bindings file has no forks object: ${path}`)
    }
    for (const [id, value] of Object.entries(record.forks)) {
      const fork = forkBindingOf(value)
      if (fork === undefined) throw new OmpBindingsError(`OMP bindings file has an invalid fork entry "${id}": ${path}`)
      forks[id] = fork
    }
  }
  return { version: BINDINGS_VERSION, sessions, forks }
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
    return (await this.load()).sessions[id]
  }

  /**
   * Record or replace one session binding.
   * @param id - Harness session identity.
   * @param binding - OMP transcript facts to persist.
   */
  async set(id: SessionId, binding: OmpBinding): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.load()
      const next: OmpBindingsFile = {
        version: BINDINGS_VERSION,
        sessions: { ...state.sessions, [id]: binding },
        forks: state.forks,
      }
      await this.write(next)
      this.state = next
    })
  }

  /**
   * Forget one session binding.
   * @param id - Harness session identity.
   */
  async delete(id: SessionId): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.load()
      if (state.sessions[id] === undefined) return
      const sessions = { ...state.sessions }
      delete sessions[id]
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
    return (await this.load()).forks[id]
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
        forks: { ...state.forks, [id]: fork },
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
      if (state.forks[id] === undefined) return
      const forks = { ...state.forks }
      delete forks[id]
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
