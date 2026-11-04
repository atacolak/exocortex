/**
 * The `/api/exocortex/omp/open` route: open one harness session onto an
 * existing OMP transcript, hydrating its recorded messages into real chat
 * bubbles and attaching the OMP process when the caller does not name a live
 * session.
 * @module @deepseek-ai/dsh-omp-rpc/open
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  OmpResumeError,
  type OmpTranscriptMatch,
} from './resume.ts'
import type { OmpSocketSession, OmpSocketState } from './socket.ts'

/** Exact shared-API route that opens an OMP transcript in a harness session. */
export const OMP_OPEN_PATH = '/api/exocortex/omp/open'

/** Bound on one open request body; it carries only ids and paths. */
export const OMP_OPEN_MAX_BODY_BYTES = 64 * 1024

/** One validated open request. */
export interface OmpOpenRequest {
  /** OMP session id, id prefix, or absolute transcript path. */
  readonly ompSession: string
  /** Existing harness session to hydrate; omitted creates a new one. */
  readonly sessionId?: string
  /** OMP profile passed as `--agent`, overriding the transcript's root agent. */
  readonly profile?: string
  /** Working directory for a newly created session. */
  readonly cwd?: string
}

/** One opened transcript outcome returned to the caller. */
export interface OmpOpenedSession {
  readonly summary: string
  readonly hydrated: number
}

/** A bare 36-character UUID: the shape a harness session id takes before branding. */
const BARE_SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/**
 * Canonicalize one harness session id at the boundary that admits it.
 *
 * Harness ids are `session-<uuid>`; the GUI and HCOM sometimes hand back the
 * bare uuid a fork or an adoption minted, which must resolve to that one same
 * session rather than inventing a second identity.
 * @param id - session id as the caller supplied it.
 * @returns the `session-` prefixed lowercase id.
 */
export function normalizeDshSessionId(id: string): string {
  return BARE_SESSION_UUID.test(id) ? `session-${id.toLowerCase()}` : id
}

/**
 * Acquire exclusive use of one OMP session id and release it when `operation` settles.
 * The same key never runs two operations at once; distinct keys stay parallel.
 */
export type OmpSessionLock = <T>(ompSessionId: string, operation: () => Promise<T>) => Promise<T>

/**
 * Create the per-OMP-session serializer shared by the open route and live adoption.
 * @returns a lock that resolves with the operation's own result or rejection.
 */
export function createOmpSessionLock(): OmpSessionLock {
  const tails = new Map<string, Promise<unknown>>()
  return <T>(ompSessionId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = tails.get(ompSessionId) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    const tail = result.then(() => undefined, () => undefined)
    tails.set(ompSessionId, tail)
    void tail.then(() => {
      if (tails.get(ompSessionId) === tail) tails.delete(ompSessionId)
    })
    return result
  }
}

/** One harness session one OMP session must map onto. */
export interface OmpSessionTarget {
  /** OMP session id whose harness binding is authoritative. */
  readonly ompSessionId: string
  /** Current binding for that OMP session; re-read inside the caller's lock. */
  readonly findBound: () => Promise<SessionId | undefined>
  /** Create the harness session when nothing is bound yet. */
  readonly create: () => Promise<SessionId>
}

/**
 * Resolve the single harness session serving one OMP session.
 * @param target - binding lookup and the fallback creation path.
 * @returns the bound or freshly created session and whether this call created it.
 */
export async function reuseOrCreateDshSession(
  target: OmpSessionTarget,
): Promise<{ readonly sessionId: SessionId; readonly created: boolean }> {
  const bound = await target.findBound()
  if (bound !== undefined) return { sessionId: bound, created: false }
  return { sessionId: await target.create(), created: true }
}

/** How one attach or wake rejoins an OMP session publication. */
export type OmpWakePlan =
  /** A live process already serves the session on its socket. */
  | { readonly kind: 'attach'; readonly session: OmpSocketSession }
  /** Wake the transcript in a fresh process; a stale publication was already collected. */
  | { readonly kind: 'resume'; readonly stalePid?: number }
  /** A live process owns the session but cannot be attached to it. */
  | { readonly kind: 'hung'; readonly pid: number; readonly reason: string }

/**
 * Decide how one harness session rejoins a published OMP session.
 *
 * OMP unloads an idle RPC process after 60 minutes without writing a terminal
 * frame, and a killed process skips its exit hook entirely, so the sidecar
 * alone proves nothing. The three publication states must stay distinct: an
 * absent sidecar means the process is gone and the transcript simply resumes,
 * a sidecar whose pid is dead means a crashed publication that must be
 * collected before resuming, and a live pid that cannot be attached to is a
 * hung session rather than a stale one.
 * @param state - publication state read from the run directory.
 * @returns the attach, resume, or refusal decision.
 */
export function planOmpWake(state: OmpSocketState): OmpWakePlan {
  switch (state.kind) {
    case 'live':
      return { kind: 'attach', session: state.session }
    case 'stale':
      return { kind: 'resume', stalePid: state.pid }
    case 'hung':
      return { kind: 'hung', pid: state.pid, reason: state.reason }
    case 'absent':
      return { kind: 'resume' }
  }
}

/**
 * Report one cold-resume attach failure as the stable refusal the open endpoint maps.
 * A cold resume reopens a stored transcript, so an attach failure is a refused
 * resume, not a harness fault; stable resume errors keep their own code.
 * @param error - failure raised while attaching a cold transcript.
 * @returns the refusal to throw, or the caller's own stable resume error.
 */
export function resumeRefused(error: unknown): OmpResumeError {
  if (error instanceof OmpResumeError) return error
  return new OmpResumeError(
    'omp/resume-refused',
    error instanceof Error ? error.message : String(error),
    409,
  )
}

/** What one open-transcript pass needs from the bridge and its attachment. */
export interface OmpTranscriptOpenDeps {
  /** OMP session identity the caller asked to open. */
  readonly ompSessionId: string
  /** OMP session already serving the harness session, when one is attached. */
  readonly attached: { readonly id: string } | undefined
  /** Attach a socket or resume the transcript; only called when nothing serves it. */
  readonly attach: () => Promise<void>
  /** Append the transcript turns the session has not recorded yet. */
  readonly hydrate: () => Promise<number>
}

/** What one open-transcript pass did. */
export interface OmpTranscriptOpenOutcome {
  /** Appended event count from the hydration pass. */
  readonly hydrated: number
  /** True when an existing attachment served the transcript, so nothing was attached. */
  readonly reused: boolean
}

/**
 * Open one transcript, reusing the process already serving it.
 *
 * A second open of the same transcript must not probe ownership or attach
 * again: the probe spawns `omp` and takes seconds, while the attachment already
 * answers for that session. Only a session bound to a different OMP session
 * detaches and attaches.
 * @param deps - requested identity, current attachment, attach, and hydrate steps.
 * @returns the hydration outcome and whether the attachment was reused.
 */
export async function openOmpTranscript(deps: OmpTranscriptOpenDeps): Promise<OmpTranscriptOpenOutcome> {
  const reused = deps.attached !== undefined && deps.attached.id === deps.ompSessionId
  if (!reused) await deps.attach()
  return { hydrated: await deps.hydrate(), reused }
}

/** Collaborators of the open endpoint. */
export interface OmpOpenDeps {
  /** Resolve one transcript id or path. */
  readonly resolveTranscript: (prefix: string) => Promise<OmpTranscriptMatch>
  /** Resolve a live harness agent, or create a session for the transcript. */
  readonly openAgent: (request: {
    readonly sessionId?: string
    /** OMP session id the harness session must be bound to one-to-one. */
    readonly ompSessionId: string
    readonly cwd: string
    readonly profile?: string
  }) => Promise<{ readonly agent: Agent; readonly agentPreset?: string }>
  /** Attach the agent to the transcript and hydrate a blank session. */
  readonly openTranscript: (request: {
    readonly agent: Agent
    readonly transcript: OmpTranscriptMatch
    readonly cwd: string
    readonly profile?: string
  }) => Promise<OmpOpenedSession>
  /**
   * Serialize this open against adoption and other opens of the same OMP
   * session. Defaults to running without exclusion.
   */
  readonly serialize?: OmpSessionLock
  /** Working directory when neither the request nor the transcript records one. */
  readonly defaultCwd?: string
  /** Profile when neither the request nor the transcript records one. */
  readonly defaultProfile?: string
  /** Receives unexpected failures before the generic response leaves. */
  readonly logError?: (error: unknown) => void
}

function invalid(message: string): OmpResumeError {
  return new OmpResumeError('request/invalid', message, 400)
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) throw invalid(`"${field}" must be a non-empty string`)
  return value.trim()
}

/**
 * Validate one open request body.
 * @param value - decoded JSON body.
 * @returns the request with trimmed non-empty fields.
 */
export function parseOmpOpenInput(value: unknown): OmpOpenRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('A JSON object body is required.')
  const record = value as Record<string, unknown>
  const ompSession = optionalString(record.ompSession, 'ompSession')
  if (ompSession === undefined) throw invalid('"ompSession" is required.')
  const sessionId = optionalString(record.sessionId, 'sessionId')
  const profile = optionalString(record.profile, 'profile')
  const cwd = optionalString(record.cwd, 'cwd')
  return {
    ompSession,
    ...sessionId === undefined ? {} : { sessionId: normalizeDshSessionId(sessionId) },
    ...profile === undefined ? {} : { profile },
    ...cwd === undefined ? {} : { cwd },
  }
}

function fail(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function jsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > OMP_OPEN_MAX_BODY_BYTES) {
    throw new OmpResumeError('request/too-large', 'Request body is too large.', 413)
  }
  if (request.body === null) throw invalid('A JSON body is required.')
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of request.body) {
    total += chunk.byteLength
    if (total > OMP_OPEN_MAX_BODY_BYTES) {
      throw new OmpResumeError('request/too-large', 'Request body is too large.', 413)
    }
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw invalid('Request body must be JSON.')
  }
}

/**
 * Serve one `POST /api/exocortex/omp/open` after transport admission.
 * @param request - authenticated Fetch request.
 * @param deps - transcript resolution, session opening, and attachment.
 * @returns JSON success with the session and transcript identity, or a stable error body.
 */
export async function serveOmpOpen(request: Request, deps: OmpOpenDeps): Promise<Response> {
  try {
    const input = parseOmpOpenInput(await jsonBody(request))
    let transcript: OmpTranscriptMatch
    try {
      transcript = await deps.resolveTranscript(input.ompSession)
    } catch (error: unknown) {
      throw new OmpResumeError(
        'omp/transcript-not-found',
        error instanceof Error ? error.message : String(error),
        404,
      )
    }
    const cwd = input.cwd ?? transcript.cwd ?? deps.defaultCwd
    if (cwd === undefined) throw invalid('"cwd" is required when the transcript records no working directory.')
    const profile = input.profile ?? transcript.profile ?? deps.defaultProfile
    const serialize: OmpSessionLock = deps.serialize ?? (<T>(_ompSessionId: string, operation: () => Promise<T>) => operation())
    const opened = await serialize(transcript.id, async () => {
      const agent = await deps.openAgent({
        ompSessionId: transcript.id,
        cwd,
        ...input.sessionId === undefined ? {} : { sessionId: input.sessionId },
        ...profile === undefined ? {} : { profile },
      })
      const outcome = await deps.openTranscript({
        agent: agent.agent,
        transcript,
        cwd,
        ...profile === undefined ? {} : { profile },
      })
      return { agent: agent.agent, agentPreset: agent.agentPreset, outcome }
    })
    return new Response(JSON.stringify({
      sessionId: opened.agent.id,
      ...opened.agentPreset === undefined ? {} : { agentPreset: opened.agentPreset },
      ompSession: {
        id: transcript.id,
        path: transcript.path,
        ...transcript.cwd === undefined ? {} : { cwd: transcript.cwd },
        ...transcript.profile === undefined ? {} : { profile: transcript.profile },
      },
      hydrated: opened.outcome.hydrated,
      summary: opened.outcome.summary,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  } catch (error: unknown) {
    if (error instanceof OmpResumeError) return fail(error.status, error.code, error.message)
    deps.logError?.(error)
    return fail(500, 'gateway/internal', 'Internal error.')
  }
}
