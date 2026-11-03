import { randomUUID } from 'node:crypto'
import type { FinishReason, GenerateOptions, RequestMessage, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { OmpRpcClient } from './client.ts'
import type { OmpAgentEvent, OmpPromptResultFrame, OmpRpcCommand, OmpRpcFrame } from './types.ts'

/** The client surface a driver needs; narrowed for tests and composition. */
export type OmpDriverClient = Pick<OmpRpcClient, 'request' | 'onFrame'>

interface OmpUsage {
  readonly input?: number
  readonly output?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly totalTokens?: number
}

interface OmpContent {
  readonly type?: string
  readonly text?: string
  readonly thinking?: string
}

interface OmpAssistantMessage {
  readonly content?: readonly OmpContent[]
  readonly usage?: OmpUsage
  readonly stopReason?: string
  readonly errorMessage?: string
}

interface OmpAssistantMessageEvent {
  readonly type: string
  readonly contentIndex?: number
  readonly delta?: string
  readonly content?: string
  readonly reason?: string
  readonly error?: OmpAssistantMessage
}

interface OmpMessageUpdate {
  readonly type: 'message_update'
  readonly messageId?: string
  readonly assistantMessageEvent?: OmpAssistantMessageEvent
  readonly message?: OmpAssistantMessage
}

interface OmpMessageStart {
  readonly type: 'message_start'
  readonly messageId?: string
  readonly message?: { readonly role?: string }
}

interface OmpMessageEnd {
  readonly type: 'message_end'
  readonly messageId?: string
  readonly message?: { readonly role?: string } & OmpAssistantMessage
}

/** One image encoded for OMP's `images` prompt/steer field. */
export interface OmpImageInput {
  readonly data: string
  readonly mimeType: string
}

/** An image block the harness assembled into a user request. */
export type OmpImageRef = Extract<RequestMessage['content'][number], { type: 'image' }>['attachment']

type OpenBlock = { readonly kind: 'text' | 'reasoning' }

/** One content block OMP reports for an executed tool. */
export interface OmpToolContentBlock {
  readonly type?: string
  readonly text?: string
  readonly data?: string
  readonly mimeType?: string
}

/** One OMP-executed tool step, projected for the harness trajectory ledger. */
export type OmpToolEvent =
  | {
    readonly kind: 'start'
    readonly toolCallId: string
    readonly toolName: string
    readonly arguments: Record<string, unknown>
  }
  | {
    readonly kind: 'end'
    readonly toolCallId: string
    readonly toolName: string
    readonly content: readonly OmpToolContentBlock[]
    readonly isError: boolean
  }

/** Terminal status carried by `prompt_result`, independent of its wire shape. */
export interface OmpPromptOutcome {
  readonly status: 'completed' | 'aborted' | 'error'
  readonly message?: string
}

/** One real user message, with images kept in their original order. */
export interface OmpUserTurn {
  readonly key: string
  readonly text: string
  readonly images: readonly OmpImageRef[]
}

/** Finish text for an OMP run whose terminal event carried no details. */
const UNKNOWN_FAILURE = 'the OMP run ended without a terminal assistant message'

/**
 * Map one OMP assistant message onto the harness chunk vocabulary.
 *
 * A cycle is one assistant message plus the tool executions it requested.
 * `endCycle` closes the blocks and reports usage/finish for that cycle;
 * `finish` additionally settles the whole prompt with its terminal status.
 * Block indexes restart at zero for every assistant message.
 */
export class OmpEventTranslator {
  private readonly open = new Map<number, OpenBlock>()
  private readonly indexes = new Map<number, number>()
  private nextIndex = 0
  private message: OmpAssistantMessage | undefined
  private failure: OmpAssistantMessage | undefined
  private settled = false

  /** Start a fresh assistant-message cycle. */
  beginCycle(): void {
    this.open.clear()
    this.indexes.clear()
    this.nextIndex = 0
    this.message = undefined
    this.failure = undefined
    this.settled = false
  }

  /**
   * Translate one inbound process event.
   * @param frame - any inbound frame; events other than message updates are ignored.
   * @returns chunks to publish, in order.
   */
  push(frame: OmpRpcFrame | OmpAgentEvent): StreamChunk[] {
    if (frame.type !== 'message_update') return []
    const update = frame as unknown as OmpMessageUpdate
    const event = update.assistantMessageEvent
    if (event === undefined || this.settled) return []
    if (update.message !== undefined) this.message = update.message
    if (event.error !== undefined) {
      this.message = event.error
      this.failure = event.error
    }
    if (event.type === 'error') {
      this.closeOpen()
      return []
    }
    if (event.type === 'done') {
      this.closeOpen()
      return []
    }
    return this.stream(event)
  }

  /**
   * Adopt the authoritative final message and close its open blocks.
   * @param message - the message payload carried by `message_end`.
   * @returns block-end chunks for every block still open.
   */
  endMessage(message: OmpAssistantMessage | undefined): StreamChunk[] {
    if (this.settled) return []
    if (message !== undefined) this.message = message
    return this.closeOpen()
  }

  /**
   * Close the current assistant message and settle its cycle without ending the prompt.
   * @returns the remaining chunks, ending in usage and finish.
   */
  endCycle(): StreamChunk[] {
    if (this.settled) return []
    return this.settle()
  }

  /**
   * Close anything still open and settle the prompt exactly once.
   * @param outcome - the prompt's terminal status, when the process reported one.
   * @returns the remaining chunks, ending in usage and finish.
   */
  finish(outcome?: OmpPromptOutcome): StreamChunk[] {
    if (this.settled) return []
    const chunks = this.settle()
    const finish = chunks.at(-1)
    if (finish?.type === 'finish' && outcome !== undefined) {
      finish.reason = outcome.status === 'aborted'
        ? { kind: 'aborted', failure: { code: 'ABORTED', message: 'the OMP run was aborted' } }
        : outcome.status === 'error'
          ? { kind: 'error', failure: { code: 'PROVIDER_ERROR', message: outcome.message ?? this.failure?.errorMessage ?? UNKNOWN_FAILURE } }
          : finish.reason
    }
    return chunks
  }

  private closeOpen(): StreamChunk[] {
    const chunks: StreamChunk[] = []
    for (const [contentIndex, open] of [...this.open]) {
      chunks.push({
        type: 'block-end',
        index: this.indexes.get(contentIndex) ?? 0,
        block: open.kind === 'text'
          ? { type: 'text', text: this.blockText(contentIndex, 'text') }
          : { type: 'reasoning', text: this.blockText(contentIndex, 'reasoning') },
      })
    }
    this.open.clear()
    this.indexes.clear()
    return chunks
  }

  private stream(event: OmpAssistantMessageEvent): StreamChunk[] {
    if (event.contentIndex === undefined) return []
    if (event.type === 'text_start' || event.type === 'thinking_start') {
      const existing = this.open.get(event.contentIndex)
      if (existing !== undefined) return []
      const kind = event.type === 'text_start' ? 'text' : 'reasoning'
      const index = this.nextIndex
      this.nextIndex += 1
      this.open.set(event.contentIndex, { kind })
      this.indexes.set(event.contentIndex, index)
      return [{ type: 'block-start', index, blockType: kind }]
    }
    const open = this.open.get(event.contentIndex)
    if (open === undefined) return []
    if (event.type === 'text_delta' || event.type === 'thinking_delta') {
      const kind = event.type === 'text_delta' ? 'text' : 'reasoning'
      if (kind !== open.kind) return []
      const text = event.delta ?? ''
      if (text.length === 0) return []
      const block = this.indexes.get(event.contentIndex) ?? 0
      return [event.type === 'text_delta'
        ? { type: 'text-delta', index: block, text }
        : { type: 'reasoning-delta', index: block, text }]
    }
    if (event.type === 'text_end' || event.type === 'thinking_end') {
      const kind = event.type === 'text_end' ? 'text' : 'reasoning'
      if (kind !== open.kind) return []
      const index = this.indexes.get(event.contentIndex) ?? 0
      this.open.delete(event.contentIndex)
      this.indexes.delete(event.contentIndex)
      const text = event.content ?? this.blockText(event.contentIndex, kind)
      return [{ type: 'block-end', index, block: kind === 'text' ? { type: 'text', text } : { type: 'reasoning', text } }]
    }
    return []
  }

  private settle(): StreamChunk[] {
    this.settled = true
    const chunks = this.closeOpen()
    const usage = usageOf(this.message?.usage)
    if (usage !== undefined) chunks.push({ type: 'usage', usage })
    chunks.push({ type: 'finish', reason: finishOf(this.message?.stopReason, this.failure ?? this.message) })
    return chunks
  }

  private blockText(contentIndex: number, kind: 'text' | 'reasoning'): string {
    const content = this.message?.content?.[contentIndex]
    if (content === undefined) return ''
    return (kind === 'text' ? content.text : content.thinking) ?? ''
  }
}

function usageOf(usage: OmpUsage | undefined): TokenUsage | undefined {
  if (usage === undefined) return undefined
  return {
    inputTokens: usage.input ?? 0,
    outputTokens: usage.output ?? 0,
    ...usage.cacheRead === undefined ? {} : { cacheReadTokens: usage.cacheRead },
    ...usage.cacheWrite === undefined ? {} : { cacheWriteTokens: usage.cacheWrite },
    ...usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens },
  }
}

function finishOf(reason: string | undefined, message: OmpAssistantMessage | undefined): FinishReason {
  if (reason === 'aborted') return { kind: 'aborted', failure: { code: 'ABORTED', message: 'the OMP run was aborted' } }
  if (reason === 'error') return { kind: 'error', failure: { code: 'PROVIDER_ERROR', message: message?.errorMessage ?? UNKNOWN_FAILURE } }
  if (reason === 'length') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function toolContentOf(value: unknown): OmpToolContentBlock[] {
  const result = objectOf(value)
  const rows = result?.content
  if (!Array.isArray(rows)) return []
  const content: OmpToolContentBlock[] = []
  for (const row of rows) {
    const block = objectOf(row)
    if (block === undefined) continue
    content.push({
      ...typeof block.type === 'string' ? { type: block.type } : {},
      ...typeof block.text === 'string' ? { text: block.text } : {},
      ...typeof block.data === 'string' ? { data: block.data } : {},
      ...typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {},
    })
  }
  return content
}

/**
 * Select the real user messages a fresh or attached OMP session has not seen.
 *
 * Only user-authored prose and image attachments cross the boundary:
 * assembled context rows, assistant text, tool calls, and tool results are
 * never echoed back into OMP. The result preserves DSH's user content order,
 * including `[Image #N]` markers and their matching `ImageContent[]` entries.
 * @param messages - the assembled request history, in conversation order.
 * @returns one entry per user message, in order.
 */
export function pureUserTurns(messages: readonly RequestMessage[]): OmpUserTurn[] {
  const turns: OmpUserTurn[] = []
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'user') continue
    if (message.source !== undefined && message.source.kind !== 'user') continue
    const text: string[] = []
    const images: OmpImageRef[] = []
    for (const block of message.content) {
      if (block.type === 'text') text.push(block.text)
      else if (block.type === 'image' && block.offloaded !== true) images.push(block.attachment)
    }
    const prose = text.join('\n')
    if (prose.trim().length === 0 && images.length === 0) continue
    turns.push({
      key: message.id === undefined ? `index:${String(index)}` : `id:${message.id}`,
      text: prose,
      images,
    })
  }
  return turns
}

interface PromptState {
  readonly id: string
  readonly channel: FrameChannel
  detach: () => void
  accepted: Promise<void>
  readonly commandOutputs: string[]
  readonly stash: OmpAgentEvent[]
  closed: boolean
  localOnly: boolean
  failure: unknown
  outcome: OmpPromptOutcome | undefined
}

/**
 * Drive harness agent steps from one long-lived OMP RPC session.
 *
 * The first prompt carries only real user messages (never assembled context
 * or assistant/tool echoes), so `[Image #N]` markers in prose line up with the
 * frame-1 image array. Later steps steer newly assembled user messages into
 * the live run while OMP keeps its own conversation state. An assistant
 * message plus its tool executions is one cycle; each cycle is one harness
 * assistant message. Tool events are buffered and handed to `onTool` before
 * the cycle settles so the harness trajectory can project them.
 */
export interface OmpAgentDriverOptions {
  /**
   * How the first prompt introduces the conversation. `replay` starts a fresh
   * OMP session and sends every real user message. `latest` trusts the attached
   * session's existing history and sends only the newest user message.
   */
  readonly transcript?: 'replay' | 'latest'
  /** Resolve harness image attachments to OMP image inputs, in request order. */
  readonly resolveImages?: (refs: readonly OmpImageRef[]) => Promise<readonly OmpImageInput[]>
  /** Observe the tool executions of one completed cycle. */
  readonly onTool?: (events: readonly OmpToolEvent[]) => void
  /** Ask the harness to continue the turn after an intermediate cycle. */
  readonly onContinue?: () => void
}

export class OmpAgentDriver {
  private sent: Set<string> | undefined
  private highWaterMark = 0
  private prompt: PromptState | undefined
  private readonly transcript: 'replay' | 'latest'
  private readonly resolveImages: ((refs: readonly OmpImageRef[]) => Promise<readonly OmpImageInput[]>) | undefined
  private readonly onTool: ((events: readonly OmpToolEvent[]) => void) | undefined
  private readonly onContinue: (() => void) | undefined

  constructor(private readonly client: OmpDriverClient, options: OmpAgentDriverOptions = {}) {
    this.transcript = options.transcript ?? 'replay'
    this.resolveImages = options.resolveImages
    this.onTool = options.onTool
    this.onContinue = options.onContinue
  }

  /**
   * Stream one step from the attached OMP session.
   * @param request - the assembled request.
   * @param signal - the step's abort signal.
   * @returns the assistant chunk stream.
   */
  async *stream(request: GenerateOptions, signal: AbortSignal): AsyncIterable<StreamChunk> {
    signal.throwIfAborted()
    if (this.sent !== undefined && request.messages.length < this.highWaterMark) await this.restart()
    const pending = this.pendingTurns(request.messages)
    let state = this.prompt
    if (state === undefined || state.closed) {
      if (pending.length === 0) {
        this.highWaterMark = Math.max(this.highWaterMark, request.messages.length)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      state = await this.startPrompt(pending)
      this.prompt = state
      this.markSent(pending)
    } else {
      for (const turn of pending) {
        signal.throwIfAborted()
        await this.steer(turn)
        this.markSent([turn])
      }
    }
    const translator = new OmpEventTranslator()
    translator.beginCycle()
    const tools: OmpToolEvent[] = []
    let openTools = 0
    let sawAssistant = false
    let cycleEnded = false
    let awaitingDecision = false
    let messageId: string | undefined
    let finalOutcome: OmpPromptOutcome | undefined
    let stepFinished = false

    const abort = (): void => {
      void this.client.request({ type: 'abort' }).catch(() => {})
      state.closed = true
      state.channel.close()
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!stepFinished) {
        const frame = await this.nextFrame(state)
        if (frame === undefined) {
          finalOutcome ??= state.outcome
          if (finalOutcome === undefined) {
            if (cycleEnded || sawAssistant) {
              finalOutcome = { status: signal.aborted ? 'aborted' : 'completed' }
            } else if (signal.aborted) {
              finalOutcome = { status: 'aborted' }
            } else if (state.localOnly) {
              finalOutcome = { status: 'completed' }
            }
          }
          stepFinished = true
          break
        }
        switch (frame.type) {
          case 'message_start': {
            const start = frame as unknown as OmpMessageStart
            if (start.message?.role !== undefined && start.message.role !== 'assistant') break
            if (awaitingDecision || cycleEnded) {
              state.stash.push(frame)
              stepFinished = true
              break
            }
            if (!sawAssistant) {
              sawAssistant = true
              messageId = start.messageId
            }
            break
          }
          case 'message_update': {
            const update = frame as unknown as OmpMessageUpdate
            if (messageId !== undefined && update.messageId !== undefined && update.messageId !== messageId) break
            for (const chunk of translator.push(frame)) {
              signal.throwIfAborted()
              yield chunk
            }
            if (update.assistantMessageEvent?.type === 'done') cycleEnded = true
            if (update.assistantMessageEvent?.type === 'done' && openTools === 0) awaitingDecision = true
            break
          }
          case 'message_end': {
            const end = frame as unknown as OmpMessageEnd
            if (end.message?.role !== undefined && end.message.role !== 'assistant') break
            if (messageId !== undefined && end.messageId !== undefined && end.messageId !== messageId) break
            sawAssistant = true
            for (const chunk of translator.push({
              type: 'message_update',
              messageId: end.messageId,
              message: end.message,
            } as unknown as OmpRpcFrame)) {
              signal.throwIfAborted()
              yield chunk
            }
            translator.endMessage(end.message)
            cycleEnded = true
            if (openTools === 0) awaitingDecision = true
            break
          }
          case 'tool_execution_start': {
            awaitingDecision = false
            openTools += 1
            const event = this.toolStart(frame)
            if (event !== undefined) tools.push(event)
            break
          }
          case 'tool_execution_end': {
            openTools = Math.max(0, openTools - 1)
            const event = this.toolEnd(frame)
            if (event !== undefined) tools.push(event)
            if (awaitingDecision && openTools === 0) stepFinished = true
            break
          }
          case 'command_output': {
            const text = typeof frame.text === 'string' ? frame.text : undefined
            if (text !== undefined) state.commandOutputs.push(text)
            break
          }
          case 'prompt_result': {
            const result = frame as unknown as OmpPromptResultFrame
            finalOutcome = {
              status: result.status,
              ...result.error?.message === undefined ? {} : { message: result.error.message },
            }
            cycleEnded = cycleEnded || sawAssistant
            stepFinished = true
            break
          }
          default:
            break
        }
        if (awaitingDecision && openTools === 0 && !stepFinished) {
          // Keep waiting: the next decisive frame is a tool start, a new
          // assistant message, or the prompt's terminal result.
          continue
        }
      }

      if (finalOutcome === undefined && state.localOnly) finalOutcome = { status: 'completed' }
      if (state.commandOutputs.length > 0 && !sawAssistant) yield* this.commandOutputChunks(state.commandOutputs)
      const final = finalOutcome !== undefined
      const settling = final ? finalOutcome : undefined
      if (final && (settling?.status === 'aborted' || settling?.status === 'error')) {
        for (const chunk of translator.finish(settling)) {
          yield chunk
        }
        state.closed = true
        this.prompt = undefined
        return
      }
      if (awaitingDecision && openTools === 0 && !final && !stepFinished) {
        // The decision frame never arrived; leave the prompt for the next step.
      }
      if (tools.length > 0 && (finalOutcome === undefined || finalOutcome.status === 'completed')) this.onTool?.(tools)
      const chunks = final ? translator.finish(settling) : translator.endCycle()
      for (const chunk of chunks) yield chunk
      this.highWaterMark = Math.max(this.highWaterMark, request.messages.length)
      if (final) {
        state.closed = true
        this.prompt = undefined
        await state.accepted
        if (state.failure !== undefined) throw state.failure instanceof Error ? state.failure : new Error('OMP stream failed', { cause: state.failure })
        return
      }
      this.onContinue?.()
      await state.accepted
      if (state.failure !== undefined) throw state.failure instanceof Error ? state.failure : new Error('OMP stream failed', { cause: state.failure })
    } finally {
      signal.removeEventListener('abort', abort)
      if (state.closed) {
        state.detach()
        state.channel.close()
      }
    }
  }

  private pendingTurns(messages: readonly RequestMessage[]): OmpUserTurn[] {
    const all = pureUserTurns(messages)
    if (this.sent === undefined) {
      if (this.transcript === 'latest' && all.length > 1) {
        const latest = all.at(-1) as OmpUserTurn
        this.sent = new Set(all.slice(0, -1).map(turn => turn.key))
        return [latest]
      }
      return all
    }
    return all.filter(turn => !this.sent?.has(turn.key))
  }

  private markSent(turns: readonly OmpUserTurn[]): void {
    this.sent ??= new Set()
    for (const turn of turns) this.sent.add(turn.key)
  }

  private async startPrompt(turns: readonly OmpUserTurn[]): Promise<PromptState> {
    const text = turns.map(turn => turn.text).filter(part => part.length > 0).join('\n\n')
    const images = await this.imagesOf(turns.flatMap(turn => [...turn.images]))
    const channel = new FrameChannel()
    const id = randomUUID()
    const state: PromptState = {
      id,
      channel,
      detach: () => {},
      accepted: Promise.resolve(),
      commandOutputs: [],
      stash: [],
      closed: false,
      localOnly: false,
      failure: undefined,
      outcome: undefined,
    }
    state.detach = this.client.onFrame((frame: OmpRpcFrame) => {
      if (frame.type === 'prompt_result') {
        const result = frame as OmpPromptResultFrame
        if (result.id !== id) return
        state.outcome = {
          status: result.status,
          ...result.error?.message === undefined ? {} : { message: result.error.message },
        }
        state.closed = true
        channel.close()
        return
      }
      if (!isCycleFrame(frame)) return
      channel.push(frame as OmpAgentEvent)
    })
    const prompt = {
      type: 'prompt',
      id,
      message: text,
      streamingBehavior: 'steer',
      ...images.length === 0 ? {} : { images },
    } as unknown as OmpRpcCommand
    state.accepted = this.client.request(prompt)
      .then((data: unknown) => {
        if (objectOf(data)?.agentInvoked === false) {
          state.localOnly = true
          state.closed = true
          channel.close()
        }
      })
      .catch((error: unknown) => {
        state.failure = error
        state.closed = true
        channel.close()
      })
    return state
  }

  private async steer(turn: OmpUserTurn): Promise<void> {
    const images = await this.imagesOf([...turn.images])
    await this.client.request({
      type: 'steer',
      message: turn.text,
      ...images.length === 0 ? {} : { images },
    } as unknown as OmpRpcCommand)
  }

  private async imagesOf(refs: readonly OmpImageRef[]): Promise<OmpImageInput[]> {
    if (refs.length === 0) return []
    if (this.resolveImages === undefined) throw new Error('OMP prompt contains images but no image resolver is configured')
    return [...await this.resolveImages(refs)]
  }

  private async *commandOutputChunks(outputs: readonly string[]): AsyncGenerator<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: outputs.join('') } }
  }

  private async nextFrame(state: PromptState): Promise<OmpAgentEvent | undefined> {
    if (state.stash.length > 0) return state.stash.shift()
    return await state.channel.next()
  }

  private toolStart(frame: OmpAgentEvent): OmpToolEvent | undefined {
    const toolCallId = typeof frame.toolCallId === 'string' ? frame.toolCallId : ''
    const toolName = typeof frame.toolName === 'string' ? frame.toolName : ''
    if (toolCallId.length === 0 || toolName.length === 0) return undefined
    return {
      kind: 'start',
      toolCallId,
      toolName,
      arguments: objectOf(frame.args) ?? {},
    }
  }

  private toolEnd(frame: OmpAgentEvent): OmpToolEvent | undefined {
    const toolCallId = typeof frame.toolCallId === 'string' ? frame.toolCallId : ''
    const toolName = typeof frame.toolName === 'string' ? frame.toolName : ''
    if (toolCallId.length === 0 || toolName.length === 0) return undefined
    return {
      kind: 'end',
      toolCallId,
      toolName,
      content: toolContentOf(frame.result),
      isError: frame.isError === true,
    }
  }

  private async restart(): Promise<void> {
    await this.client.request({ type: 'new_session' })
    this.sent = undefined
    this.highWaterMark = 0
    this.prompt?.channel.close()
    this.prompt?.detach()
    this.prompt = undefined
  }
}

function isCycleFrame(frame: OmpRpcFrame): boolean {
  return frame.type === 'message_start'
    || frame.type === 'message_update'
    || frame.type === 'message_end'
    || frame.type === 'tool_execution_start'
    || frame.type === 'tool_execution_end'
    || frame.type === 'command_output'
}

/** Ordered, closeable frame feed shared between the client listener and the generator. */
class FrameChannel {
  private readonly buffered: OmpAgentEvent[] = []
  private waiter: (() => void) | undefined
  private closed = false

  push(frame: OmpAgentEvent): void {
    if (this.closed) return
    this.buffered.push(frame)
    this.wake()
  }

  close(): void {
    this.closed = true
    this.wake()
  }

  async next(): Promise<OmpAgentEvent | undefined> {
    while (true) {
      if (this.buffered.length > 0) return this.buffered.shift()
      if (this.closed) return undefined
      await new Promise<void>((resolve) => { this.waiter = resolve })
    }
  }

  private wake(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }
}
