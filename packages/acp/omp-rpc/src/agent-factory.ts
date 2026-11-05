/**
 * Native OMP agent factory: one harness Agent per OMP session, driven directly
 * by the OMP RPC event stream. There is no ReactLoop, no `omp:continue`, and
 * no synthetic model request: every assistant cycle OMP produces becomes one
 * durable harness step inside the turn.
 *
 * @module @deepseek-ai/dsh-omp-rpc/agent-factory
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  AgentModel,
  agentEvents,
  installModelSelection,
  type Agent,
  type AgentCancelCause,
  type AgentFactory,
  type AgentHandle,
  type AgentOptions,
  type AgentStatus,
  type AgentEventDispatch,
  type AssistantStreamFrame,
  type CreateAgentOptions,
  type Inbox,
  type InboxState,
  type InboxWireState,
  type InboxTarget,
  type ModelSelectionProjectionState,
  type ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import {
  AssistantStreamAccumulator,
  BlockAssembler,
  LlmAttemptId,
  createAssistantMessage,
  createUserMessage,
  type AssistantStreamRecord,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type ReplayEnvelope,
  type StreamChunk,
  type TokenUsage,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import {
  SessionLogOffset,
  interruptedTurnClosers,
  type Session,
  type SessionEvent,
  type SessionEventMap,
  type SessionHeader,
  type SessionId,
  type SessionSeq,
  type TurnEndReason,
} from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { OmpBridge, OmpExternalWake } from './bridge.ts'
import type { OmpAgentDriver, OmpToolEvent } from './driver.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'omp-continue': { kind: 'omp-continue' }
  }
}

/** Projection readers and attachment capability the bridge plugin supplies. */
export interface OmpAgentHost {
  /** Attach or adopt the OMP process serving one agent. */
  ensureSession(agent: OmpSessionAgent, signal?: AbortSignal): Promise<void>
  /** Driver bound to one session by {@link OmpBridge}. */
  driverOf(id: SessionId): OmpAgentDriver | undefined
  /** Take the tool events the driver collected during the latest cycle. */
  takeTools(id: SessionId): OmpToolEvent[]
  /** Project tool events at one turn and step. */
  projectTools(id: SessionId, turn: number, step: number, events: readonly OmpToolEvent[]): void
  /** Agent model-selection projection reader. */
  modelSelection(session: Session): () => ModelSelectionProjectionState
  /** Agent inbox projection reader. */
  inbox(session: Session): () => InboxState
}

/** Agent-owned projection of durable inbox splices. */
export const inboxProjectionDefinition: Required<ProjectionDefinition<'inbox', InboxState>> = {
  key: 'inbox',
  stateVersion: 1,
  stateSchema: z.object({
    'next-turn': z.array(z.custom<UserMessage>()).readonly(),
    'next-step': z.array(z.custom<UserMessage>()).readonly(),
  }).readonly(),
  init: () => ({ 'next-turn': [], 'next-step': [] }),
  apply: (state, event) => {
    if (event.type !== 'agent/inbox/spliced') return state
    const target = event.data.target
    const removed = event.data.removedCount ?? 0
    const next = state[target].toSpliced(event.data.start, removed, ...event.data.inserted)
    return target === 'next-turn'
      ? { 'next-turn': next, 'next-step': state['next-step'] }
      : { 'next-turn': state['next-turn'], 'next-step': next }
  },
  wire: {
    viewSchema: z.custom<InboxWireState>(),
    view: (state) => {
      const wire: InboxWireState = JSON.parse(JSON.stringify(state))
      return wire
    },
  },
}

/** Durable pending input for one agent. */
class NativeInbox implements Inbox {
  /**
   * @param session - session receiving durable splice events.
   * @param read - projection reader used to rehydrate after reload.
   * @param dispatch - agent-scoped notification publisher.
   */
  constructor(
    private readonly session: Session,
    private readonly read: () => InboxState,
    private readonly dispatch: AgentEventDispatch,
  ) {}

  get nextTurn(): readonly UserMessage[] { return this.read()['next-turn'] }
  get nextStep(): readonly UserMessage[] { return this.read()['next-step'] }

  /**
   * Apply one normalized splice and publish it durably and to live subscribers.
   * @param target - pending list to mutate.
   * @param start - splice position.
   * @param deleteCount - maximum number of messages to remove.
   * @param inserted - messages to insert.
   * @returns removed messages.
   */
  splice(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]): UserMessage[] {
    const current = [...this.read()[target]]
    const removed = current.splice(start, deleteCount, ...inserted)
    this.session.append('agent/inbox/spliced', {
      target,
      start,
      ...removed.length === 0 ? {} : { removedCount: removed.length },
      inserted,
      ...removed.length === 0 ? {} : { outcome: 'canceled' as const },
    })
    for (const message of removed) this.dispatch.emit('agent/inbox/discarded', { message })
    for (const message of inserted) this.dispatch.emit('agent/inbox/inserted', { message })
    return removed
  }

  clear(): void {
    if (this.read()['next-step'].length > 0) this.splice('next-step', 0, this.read()['next-step'].length, [])
    if (this.read()['next-turn'].length > 0) this.splice('next-turn', 0, this.read()['next-turn'].length, [])
  }

  /**
   * Claim the first queued next-turn message for a turn that will run it.
   * @param turn - durable turn that now owns the message.
   * @returns the claimed message, or undefined when nothing is queued.
   */
  claimNextTurn(turn: number): UserMessage | undefined {
    const [message] = this.take('next-turn', 1)
    if (message !== undefined) this.dispatch.emit('agent/inbox/claimed', { message, turn })
    return message
  }

  /**
   * Claim queued next-step messages a step boundary will hand to OMP.
   * @param turn - durable turn that now owns the messages.
   * @returns the claimed messages in queue order.
   */
  claimNextStep(turn: number): readonly UserMessage[] {
    const claimed = this.take('next-step', this.read()['next-step'].length)
    for (const message of claimed) this.dispatch.emit('agent/inbox/claimed', { message, turn })
    return claimed
  }

  private take(target: InboxTarget, deleteCount: number): UserMessage[] {
    const current = [...this.read()[target]]
    const removed = current.splice(0, deleteCount)
    if (removed.length === 0) return []
    this.session.append('agent/inbox/spliced', {
      target,
      start: 0,
      removedCount: removed.length,
      inserted: [],
    })
    return removed
  }

  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.read()[target].length, 0, [message])
  }

  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message])
  }

  replace(messageId: UserMessage['id'], newMessage: UserMessage): boolean {
    for (const target of ['next-step', 'next-turn'] as const) {
      const index = this.read()[target].findIndex(message => message.id === messageId)
      if (index < 0) continue
      this.splice(target, index, 1, [newMessage])
      return true
    }
    return false
  }

  remove(messageId: UserMessage['id']): boolean {
    for (const target of ['next-step', 'next-turn'] as const) {
      const index = this.read()[target].findIndex(message => message.id === messageId)
      if (index < 0) continue
      this.splice(target, index, 1, [])
      return true
    }
    return false
  }
}

/** Fold one OMP assistant cycle into one compact stream and ordered live frames. */
class NativeAssistantStreamAttempt {
  private readonly accumulator = new AssistantStreamAccumulator()
  private readonly assembler = new BlockAssembler()
  private index = 0
  private terminal = false
  readonly attemptId: LlmAttemptId

  constructor(
    sessionId: SessionId,
    attempt: number,
    private readonly nextRevision: () => number,
    readonly turn: number,
    readonly step: number,
    private readonly emit: (frame: AssistantStreamFrame) => void,
  ) {
    this.attemptId = LlmAttemptId(`${sessionId}:${attempt}`)
  }

  get ended(): boolean { return this.terminal }

  start(): void {
    this.emit({ type: 'start', attemptId: this.attemptId, revision: this.nextRevision(), turn: this.turn, step: this.step })
  }

  push(chunk: StreamChunk): void {
    const timed = this.accumulator.push({ time: Date.now(), chunk })
    this.assembler.push(timed.chunk)
    this.emit({
      type: 'chunk',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index++,
      time: timed.time,
      chunk: timed.chunk,
    })
  }

  settle(eventType: 'assistant/message' | 'assistant/attempt', append: () => SessionSeq): void {
    let seq: SessionSeq
    try {
      seq = append()
    } catch (error: unknown) {
      this.abandon()
      throw error
    }
    this.terminal = true
    this.emit({
      type: 'end',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index,
      outcome: { kind: 'committed', eventType, seq },
    })
  }

  abandon(): void {
    this.terminal = true
    this.emit({
      type: 'end',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index,
      outcome: { kind: 'abandoned' },
    })
  }

  get stream(): SessionEventMap['assistant/attempt']['stream'] {
    return [...this.accumulator.snapshot()] as AssistantStreamRecord[]
  }

  blocks(): ContentBlock[] { return this.assembler.blocks() }
  interruptedBlocks(): ContentBlock[] { return this.assembler.interruptedBlocks() }
  get usage(): TokenUsage | undefined { return this.assembler.usage }
  get finish(): FinishReason { return this.assembler.finish }
  get replayState(): ReplayEnvelope | undefined { return this.assembler.replayState }
}

interface Phase {
  readonly turn: number
  readonly controller: AbortController
}

function abortedCancelCause(signal: AbortSignal): AgentCancelCause | undefined {
  if (!signal.aborted) return undefined
  const cause = signal.reason as AgentCancelCause
  switch (cause.kind) {
    case 'user':
    case 'parent':
    case 'disposed':
      return { kind: cause.kind }
    case 'hook':
      return { kind: 'hook', reason: cause.reason }
    default:
      return undefined
  }
}

/** One agent whose turns are executed inside OMP. */
export class OmpSessionAgent implements Agent {
  readonly id: SessionId
  readonly session: Session
  readonly options: AgentOptions
  readonly model: AgentModel
  readonly inbox: NativeInbox
  readonly ctx: Context
  /** Per-agent scope carrying the services this agent's turns run against. */
  readonly scope: ReturnType<typeof createScope>
  private readonly dispatch: ReturnType<typeof agentEvents>
  private phase: Phase | undefined
  private driver: OmpAgentDriver | undefined
  private attachPromise: Promise<OmpAgentDriver> | undefined
  private idleWaiters: (() => void)[] = []
  private attemptCounter = 0
  private streamRevision = 0
  private disposed = false

  /**
   * @param ownerCtx - context owning the agent scope and resources.
   * @param session - prepared session this agent drives.
   * @param options - route fallback and output controls.
   * @param host - bridge-backed attachment and projection capability.
   */
  constructor(
    ownerCtx: Context,
    session: Session,
    options: AgentOptions,
    private readonly host: OmpAgentHost,
  ) {
    this.id = session.id
    this.session = session
    this.options = options
    this.scope = createScope(ownerCtx, this)
    this.ctx = this.scope.ctx
    this.dispatch = agentEvents(this.ctx, this)
    this.model = new AgentModel(host.modelSelection(session), session, options)
    this.inbox = new NativeInbox(session, host.inbox(session), this.dispatch)
    installModelSelection(this.ctx)
  }

  get status(): AgentStatus {
    return this.phase === undefined ? 'idle' : 'running'
  }

  private setPhase(phase: Phase | undefined): void {
    const previous = this.status
    this.phase = phase
    if (this.status !== previous) this.dispatch.emit('agent/status', { status: this.status })
  }

  cancel(cause: AgentCancelCause, options: { keepInbox?: boolean } = {}): void {
    if (this.disposed) return
    if (options.keepInbox !== true) this.inbox.clear()
    const phase = this.phase
    if (phase === undefined) return
    if (cause.kind === 'user') this.driver?.markUserCancel()
    if (!phase.controller.signal.aborted) phase.controller.abort(cause)
  }

  whenIdle(): Promise<void> {
    if (this.phase === undefined) return Promise.resolve()
    return new Promise<void>((resolve) => { this.idleWaiters.push(resolve) })
  }

  async runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase !== undefined) throw new Error('an agent turn is already active')
    const controller = new AbortController()
    return await task(controller.signal)
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    if (this.disposed) return
    if (target === 'next-step' && this.status === 'running' && wakeup) {
      this.steer(message)
      return
    }
    this.inbox.append(target, message)
    if (wakeup && target === 'next-turn' && this.status === 'idle') this.startTurn(message)
  }

  followup(message: UserMessage): void {
    if (this.disposed) return
    if (this.status === 'running') {
      this.inbox.append('next-turn', message)
      return
    }
    this.startTurn(message)
  }

  steer(message: UserMessage): void {
    if (this.disposed) return
    if (this.status === 'idle') {
      this.startTurn(message)
      return
    }
    this.session.append('user/message', message, { surfaceOp: 'append' })
    const driver = this.driver
    if (driver === undefined || !driver.hasActiveRun()) {
      this.inbox.append('next-step', message)
      return
    }
    void driver.steerImmediate([message]).catch((error: unknown) => {
      this.ctx.logger.warn(`omp-rpc: immediate steer failed: ${String(error)}`)
      this.inbox.append('next-step', message)
    })
  }

  inject(message: UserMessage): void {
    if (this.status === 'running') {
      const driver = this.driver
      if (driver !== undefined && driver.hasActiveRun()) {
        void driver.steerImmediate([message]).catch(() => { this.inbox.append('next-step', message) })
        return
      }
    }
    this.inbox.append('next-step', message)
  }

  forgetOmpDriver(driver: OmpAgentDriver): void {
    if (this.driver !== driver) return
    this.driver = undefined
    this.attachPromise = undefined
  }

  /**
   * Project one OMP-initiated run into the session. An idle wake queues on the inbox before the
   * Turn opens because `runTurn` claims only when it starts without an initial message; handing
   * the wake to `startTurn` would leave it unclaimed and therefore hidden from Chat. A wake that
   * arrives mid-Turn is recorded without a claim so it stays in Trajectory.
   * @param wake - the waking input and its trigger attribution.
   */
  projectExternalWake(wake: OmpExternalWake): void {
    if (this.disposed) return
    const message = createUserMessage({
      content: [{ type: 'text', text: wake.text }],
      source: wake.source ?? { kind: 'user' },
    })
    if (this.phase === undefined) {
      this.inbox.append('next-turn', message)
      this.startTurn(undefined)
      return
    }
    this.session.append('user/message', message, { surfaceOp: 'append' })
  }

  /** Attach eagerly so native slash commands and host tools exist before the first prompt. */
  async attach(): Promise<void> {
    await this.ensureDriver()
  }

  /** Detach quietly; the socket owner keeps its run. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.cancel({ kind: 'disposed' }, { keepInbox: true })
    await this.whenIdle()
    await this.scope.dispose()
  }

  private startTurn(message: UserMessage | undefined): void {
    if (this.phase !== undefined) return
    const controller = new AbortController()
    const turn = this.ctx.agents.turnBoundaryOf(this.session).lastTurn + 1
    const phase: Phase = { turn, controller }
    this.setPhase(phase)
    void this.runTurn(phase, message)
  }

  private finishPhase(phase: Phase): void {
    if (this.phase !== phase) return
    this.setPhase(undefined)
    const next = this.inbox.claimNextTurn(phase.turn + 1)
    if (next !== undefined) {
      this.startTurn(next)
      return
    }
    const waiters = this.idleWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  private async ensureDriver(): Promise<OmpAgentDriver> {
    if (this.driver !== undefined) return this.driver
    this.attachPromise ??= (async () => {
      await this.host.ensureSession(this)
      const driver = this.host.driverOf(this.id)
      if (driver === undefined) throw new Error(`OMP attachment for "${this.id}" published no driver`)
      this.driver = driver
      return driver
    })()
    try {
      return await this.attachPromise
    } catch (error: unknown) {
      this.attachPromise = undefined
      throw error
    }
  }

  private request(): GenerateOptions {
    const selection = this.model.current() ?? { provider: 'cpa', model: 'unknown' }
    return {
      provider: selection.provider,
      model: selection.model,
      messages: this.session.deriveMessages(),
    }
  }

  private async runTurn(phase: Phase, initial: UserMessage | undefined): Promise<void> {
    let outcome: TurnEndReason | undefined
    let stepOpen = false
    let stickyMaxTokens = false
    let outcomeFailure: { readonly message: string; readonly code: string } | undefined
    try {
      this.session.append('turn/start', { turn: phase.turn })
      const prompt = initial ?? this.inbox.claimNextTurn(phase.turn)
      if (prompt !== undefined) {
        this.session.append('user/message', prompt, { surfaceOp: 'append' })
      }
      const driver = await this.ensureDriver()
      phase.controller.signal.throwIfAborted()
      let step = 0
      while (!phase.controller.signal.aborted) {
        step += 1
        const queued = this.inbox.claimNextStep(phase.turn)
        if (queued.length > 0) {
          try {
            await driver.steerImmediate(queued)
          } catch (error: unknown) {
            this.ctx.logger.warn(`omp-rpc: queued step input failed: ${String(error)}`)
            for (const message of queued) this.inbox.append('next-step', message)
          }
        }
        const attempt = new NativeAssistantStreamAttempt(
          this.id,
          ++this.attemptCounter,
          () => ++this.streamRevision,
          phase.turn,
          step,
          frame => { this.dispatch.emit('agent/assistant-stream', { frame }) },
        )
        let started = false
        let sawChunks = false
        let finish: FinishReason | undefined
        const openStep = (): void => {
          if (stepOpen) return
          this.session.append('step/start', { turn: phase.turn, step })
          stepOpen = true
        }
        try {
          for await (const chunk of driver.stream(this.request(), phase.controller.signal)) {
            if (phase.controller.signal.aborted) break
            if (chunk.type === 'finish') {
              finish = chunk.reason
              continue
            }
            openStep()
            if (!started) { started = true; attempt.start() }
            sawChunks = true
            attempt.push(chunk)
          }
          if (phase.controller.signal.aborted) break
          const tools = this.host.takeTools(this.id)
          if (tools.length > 0 || started || sawChunks) {
            openStep()
            if (!started) { started = true; attempt.start() }
            const blocks = [...attempt.blocks()]
            for (const event of tools) {
              if (event.kind !== 'start') continue
              if (event.arguments.i === undefined) event.arguments.i = event.toolName
              blocks.push({
                type: 'tool-call',
                id: callId(event.toolCallId),
                name: event.toolName,
                arguments: JSON.stringify(event.arguments),
              })
            }
            const selection = this.model.current() ?? { provider: 'cpa', model: 'unknown' }
            const message = createAssistantMessage({
              content: phase.controller.signal.aborted ? attempt.interruptedBlocks() : blocks,
              source: {
                provider: selection.provider,
                model: selection.model,
                ...attempt.replayState === undefined ? {} : { replayState: attempt.replayState },
              },
            })
            attempt.settle('assistant/message', () => this.session.append('assistant/message', {
              turn: phase.turn,
              step,
              message,
              ...attempt.usage === undefined ? {} : { usage: attempt.usage },
              stream: attempt.stream,
              ...phase.controller.signal.aborted ? { interrupted: true } : {},
            }, { surfaceOp: 'append' }).seq)
            this.host.projectTools(this.id, phase.turn, step, tools)
          }
          if (finish?.kind === 'error') {
            outcomeFailure = { message: finish.failure.message, code: finish.failure.code }
          }
          if (finish?.kind === 'max-tokens') stickyMaxTokens = true
        } catch (error: unknown) {
          if (!attempt.ended) attempt.abandon()
          if (phase.controller.signal.aborted) break
          throw error
        } finally {
          if (stepOpen) {
            this.session.append('step/end', { turn: phase.turn, step })
            stepOpen = false
          }
        }
        if (!driver.hasActiveRun()) break
      }
      if (phase.controller.signal.aborted) {
        outcome = { kind: 'aborted', reason: abortedCancelCause(phase.controller.signal) ?? { kind: 'legacy' } }
      } else if (outcomeFailure !== undefined) {
        outcome = { kind: 'error', error: outcomeFailure }
      } else if (stickyMaxTokens) {
        outcome = { kind: 'max-tokens' }
      } else {
        outcome = { kind: 'completed' }
      }
    } catch (error: unknown) {
      outcome = phase.controller.signal.aborted
        ? { kind: 'aborted', reason: abortedCancelCause(phase.controller.signal) ?? { kind: 'legacy' } }
        : { kind: 'error', error: { message: error instanceof Error ? error.message : String(error), code: 'UNKNOWN' } }
    } finally {
      try {
        if (outcome !== undefined) this.session.append('turn/end', { turn: phase.turn, reason: outcome })
      } finally {
        this.finishPhase(phase)
      }
    }
  }
}

function callId(id: string): SessionEventMap['tool/call']['callId'] {
  return id as SessionEventMap['tool/call']['callId']
}

/**
 * What lossless recovery hands back: the header to recreate under, plus the
 * decoded prefix the refusing backend salvaged before its corrupt tail. The
 * prefix carries committed events the canonical source never received — an
 * un-delivered prompt and its inbox splice — so recreating an empty Session
 * would drop input no transcript can replay.
 */
export interface OmpRecoveredSession extends SessionHeader {
  /** Readable prefix from the refused artifact; absent when the backend decoded none. */
  readonly salvagedEvents?: readonly SessionEvent[]
}

/** Structural owner interface used by the factory heartbeat counters. */
export interface OmpAgentFactoryOptions {
  readonly ctx: Context
  readonly host: OmpAgentHost
  /**
   * Tail-sync a reopened session from its recorded OMP transcript before the
   * agent is announced, so a plain reopen or browser reload projects the turns
   * OMP wrote while the harness was detached.
   */
  readonly hydrate?: (agent: Agent) => Promise<void>
  /**
   * Set aside a persisted artifact that fails session-format validation and
   * return the header to recreate. The bridge quarantines the unusable file and
   * rehydrates the session from its bound OMP transcript, because the artifact
   * is a derived mirror of a transcript that still exists.
   * @param id - persisted session whose open failed validation.
   * @param failure - format error that refused the artifact.
   * @returns header to recreate the session from, or undefined to leave it untouched.
   */
  readonly recover?: (id: SessionId, failure: Error) => Promise<OmpRecoveredSession | undefined>
}

/** Maximum `cause` links inspected before a failure counts as unrelated. */
const SESSION_FORMAT_CAUSE_DEPTH = 8

/**
 * Session-format failures cross into this package without a direct dependency,
 * and a backend may wrap the refusal in its own corruption error while keeping
 * the original as `cause`. Traverse that chain up to
 * {@link SESSION_FORMAT_CAUSE_DEPTH} links, stopping at a repeated object, so
 * a wrapped format refusal still selects lossless recovery.
 *
 * `SessionFormatUnsupportedError` is deliberately not a format refusal: the log
 * is intact but this build cannot interpret it, so quarantine would discard an
 * artifact a newer build still reads. That refusal keeps its upgrade remedy.
 */
function isSessionFormatError(error: unknown): error is Error {
  const seen = new Set<unknown>()
  let current: unknown = error
  for (let depth = 0; depth < SESSION_FORMAT_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error) || seen.has(current)) return false
    seen.add(current)
    if (current.name === 'SessionFormatError') return true
    current = current.cause
  }
  return false
}

/** Agent factory registered through `ctx.agents.setFactory`. */
export class OmpAgentFactory implements Factory {
  /** @param options - context carrying services and the bridge-backed host. */
  constructor(private readonly options: OmpAgentFactoryOptions) {}

  private get ctx(): Context { return this.options.ctx }

  /**
   * Create one agent and its session under the caller's identity.
   * @param ownerCtx - caller-owned context.
   * @param options - identity, metadata, setup, and cancellation.
   * @returns the owned handle.
   */
  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const preparation = this.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.meta === undefined ? {} : { meta: options.meta },
      ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
    })
    const session = preparation
    const stored = await this.createStoredSession(session, options.signal)
    return await this.initialize(ownerCtx, {
      session,
      ...stored === undefined ? {} : { stored },
      agentOptions: options.agentOptions ?? {},
      ...options.setup === undefined ? {} : { setup: options.setup },
      ...options.signal === undefined ? {} : { signal: options.signal },
      source: 'startup',
      ...options.parentAgent === undefined ? {} : { parentAgent: options.parentAgent },
    })
  }

  /**
   * Resume one persisted session with its native OMP attachment.
   * @param ownerCtx - caller-owned context.
   * @param options - persisted identity, setup, and cancellation.
   * @returns the owned handle.
   */
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence = this.ctx.get("sessionPersistence")
    if (persistence === undefined) throw new Error("cannot resume: session persistence is not configured")
    const id = options.resumeSessionId
    try {
      return await this.resumeStored(persistence, ownerCtx, options)
    } catch (error: unknown) {
      if (!isSessionFormatError(error) || this.options.recover === undefined) throw error
      const recovered = await this.options.recover(id, error)
      if (recovered === undefined) throw error
      return await this.recreate(persistence, ownerCtx, options, recovered)
    }
  }

  private async resumeStored(persistence: SessionPersistence, ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const id = options.resumeSessionId
    const handle = await persistence.open(id, 'write', { ...options.signal === undefined ? {} : { signal: options.signal } })
    try {
      const coldRead = await handle.read(0, undefined, { ...options.signal === undefined ? {} : { signal: options.signal } })
      const closers = interruptedTurnClosers(coldRead.events)
      if (closers.length > 0) await handle.append(closers)
      const session = this.ctx.sessions.prepare(id, {
        seed: [...coldRead.events, ...closers],
        meta: structuredClone(handle.header),
        inheritedEventCount: handle.inheritedEventCount,
        eventState: coldRead.eventState,
      })
      const stored = { handle, storedCount: coldRead.events.length + closers.length }
      return await this.initialize(ownerCtx, {
        session,
        stored,
        agentOptions: options.agentOptions ?? {},
        ...options.setup === undefined ? {} : { setup: options.setup },
        ...options.signal === undefined ? {} : { signal: options.signal },
        source: 'resume',
        ...options.parentAgent === undefined ? {} : { parentAgent: options.parentAgent },
      })
    } catch (error: unknown) {
      await handle.close().catch(() => {})
      throw error
    }
  }

  private async recreate(
    persistence: SessionPersistence,
    ownerCtx: Context,
    options: ResumeAgentOptions,
    recovered: OmpRecoveredSession,
  ): Promise<AgentHandle> {
    const { salvagedEvents, ...header } = recovered
    const handle = await persistence.create(header, { ...options.signal === undefined ? {} : { signal: options.signal } })
    try {
      const salvaged = salvagedEvents ?? []
      const session = this.ctx.sessions.prepare(options.resumeSessionId, {
        meta: structuredClone(header),
        ...salvaged.length === 0 ? {} : { seed: [...salvaged] },
      })
      return await this.initialize(ownerCtx, {
        session,
        stored: { handle, storedCount: 0 },
        agentOptions: options.agentOptions ?? {},
        ...options.setup === undefined ? {} : { setup: options.setup },
        ...options.signal === undefined ? {} : { signal: options.signal },
        source: 'resume',
        ...options.parentAgent === undefined ? {} : { parentAgent: options.parentAgent },
      })
    } catch (error: unknown) {
      await handle.close().catch(() => {})
      throw error
    }
  }

  private async createStoredSession(session: Session, signal?: AbortSignal): Promise<StoredSession | undefined> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    const handle = await persistence.create(session.header, {
      inheritedEventCount: session.inheritedEventCount,
      ...signal === undefined ? {} : { signal },
    })
    return { handle, storedCount: 0 }
  }

  private async initialize(ownerCtx: Context, input: InitializeInput): Promise<AgentHandle> {
    ownerCtx.fiber.assertActive()
    const { session, stored } = input
    const agent = new OmpSessionAgent(this.ctx, session, input.agentOptions, this.options.host)
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let disposing: Promise<void> | undefined
    const dispose = (): Promise<void> => (disposing ??= (async () => {
      const failures: unknown[] = []
      try {
        agent.cancel({ kind: 'disposed' }, { keepInbox: true })
        await agent.whenIdle()
      } catch (error: unknown) { failures.push(error) }
      try { await agent.dispose() } catch (error: unknown) { failures.push(error) }
      try { await stored?.handle.close() } catch (error: unknown) { failures.push(error) }
      try {
        detachAgent?.()
        detachSession?.()
      } catch (error: unknown) { failures.push(error) }
      if (failures.length > 0) throw new AggregateError(failures, `agent "${agent.id}" disposal failed`)
    })())
    try {
      await this.appendUnstoredSuffix(stored, session)
      detachSession = this.ctx.sessions.enter(session)
      this.ctx.sessions.announce(session)
      await this.options.hydrate?.(agent)
      const setupCommit = await input.setup?.(agent.ctx, agent)
      setupCommit?.commit()
      detachAgent = this.ctx.agents.enter(agent, input.parentAgent)
      await this.ctx.agents.announce(agent, input.source, input.signal)
      ownerCtx.effect(() => () => dispose(), `omp-agent(${agent.id})`)
      return { agent, dispose }
    } catch (error: unknown) {
      await dispose().catch(() => {})
      throw error
    }
  }

  private async appendUnstoredSuffix(stored: StoredSession | undefined, session: Session): Promise<void> {
    if (stored === undefined) return
    const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount))
    if (suffix.length > 0) await stored.handle.append(suffix)
    stored.storedCount += suffix.length
  }
}

interface StoredSession {
  readonly handle: SessionHandle
  storedCount: number
}

interface InitializeInput {
  readonly session: Session
  readonly stored?: StoredSession
  readonly agentOptions: AgentOptions
  readonly setup?: CreateAgentOptions['setup'] | ResumeAgentOptions['setup']
  readonly signal?: AbortSignal
  readonly source: 'startup' | 'resume'
  readonly parentAgent?: Agent
}

type Factory = AgentFactory
