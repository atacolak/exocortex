import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { modelSelectionProjectionDefinition, type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import SessionStore, {
  KNOWN_SESSION_EVENT_TYPES,
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OmpAgentFactory,
  inboxProjectionDefinition,
  type OmpAgentHost,
} from '../src/agent-factory.ts'
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { hydrateOmpBinding, OmpBindings } from '../src/bindings.ts'
import { quarantineCorruptSession, recoverBoundMirror } from '../src/index.ts'
import { OmpAgentDriver, type OmpToolEvent } from '../src/driver.ts'
import { hydrateOmpSession, type OmpHydrationCursor } from '../src/resume.ts'
import { rpcHarness, tick, type RpcHarness } from './harness.ts'

interface Harness {
  readonly ctx: Context
  readonly rpc: RpcHarness
  readonly driver: OmpAgentDriver
  readonly toolCalls: OmpToolEvent[]
  readonly host: OmpAgentHost
  readonly cwd: string
}

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

interface HarnessOverrides {
  readonly hydrate?: (agent: Agent) => Promise<void>
  readonly recover?: (ctx: Context, id: SessionId, failure: Error) => Promise<SessionHeader | undefined>
}

async function harness(overrides: HarnessOverrides = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'omp-factory-'))
  roots.push(root)
  const cwd = join(root, 'project')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const modelSelection = await ctx.sessionProjections.register(modelSelectionProjectionDefinition)
  const inbox = await ctx.sessionProjections.register(inboxProjectionDefinition)

  const rpc = rpcHarness()
  const toolCalls: OmpToolEvent[] = []
  let takenTools: OmpToolEvent[] = []
  const driver = new OmpAgentDriver(rpc.client, {
    transcript: 'latest',
    onTool: (events) => { takenTools = [...events] },
  })
  const host: OmpAgentHost = {
    ensureSession: async () => {},
    driverOf: () => driver,
    takeTools: () => {
      const taken = takenTools
      takenTools = []
      return taken
    },
    projectTools: (id, turn, step, events) => {
      toolCalls.push(...events)
      const session = ctx.sessions.get(id)
      if (session === undefined) return
      for (const event of events) {
        const callId = ToolCallId(event.toolCallId)
        if (event.kind === 'start') {
          session.append('tool/call', {
            turn,
            step,
            callId,
            name: event.toolName,
            arguments: JSON.stringify(event.arguments),
          })
          continue
        }
        session.append('tool/result', {
          turn,
          step,
          message: createToolResultMessage({
            callId,
            content: event.content.map(block => block.type === 'image'
              ? { type: 'text' as const, text: `[image: ${block.mimeType ?? 'unknown'}]` }
              : { type: 'text' as const, text: block.text ?? '' }),
            isError: event.isError,
          }),
        }, { surfaceOp: 'append' })
      }
    },
    modelSelection: session => modelSelection.readerFor(session),
    inbox: session => inbox.readerFor(session),
  }
  await ctx.plugin({
    name: 'omp-rpc factory harness',
    inject: ['agents', 'sessions', 'sessionProjections'],
    apply(pluginCtx: Context) {
      pluginCtx.agents.setFactory(new OmpAgentFactory({
        ctx: pluginCtx,
        host,
        ...overrides.hydrate === undefined ? {} : { hydrate: overrides.hydrate },
        ...overrides.recover === undefined
          ? {}
          : { recover: (id, failure) => overrides.recover!(pluginCtx, id, failure) },
      }))
    },
  })
  return { ctx, rpc, driver, toolCalls, host, cwd }
}

async function createAgent(h: Harness, id: string): Promise<{ agent: Agent; dispose: () => Promise<void> }> {
  const handle = await h.ctx.agents.create({
    sessionId: SessionId(id),
    meta: { cwd: h.cwd },
    agentOptions: { provider: 'cpa', model: 'gemini-4-argon-high' },
  })
  return { agent: handle.agent, dispose: handle.dispose }
}

function userInput(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function promptOf(h: Harness): Record<string, unknown> {
  const prompt = h.rpc.written.map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(frame => frame.type === 'prompt')
    .at(-1)
  if (prompt === undefined) throw new Error('the factory wrote no prompt frame')
  return prompt
}

function acceptPrompt(h: Harness): void {
  const prompt = promptOf(h)
  h.rpc.receive({ type: 'response', id: prompt.id, command: 'prompt', success: true, data: { agentInvoked: true } })
}

function assistantMessage(
  text: string,
  stopReason: string,
  usage: Record<string, number>,
  errorMessage?: string,
): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason,
    ...errorMessage === undefined ? {} : { errorMessage },
    usage: { input: usage.input, output: usage.output, totalTokens: usage.total },
  }
}

function assistantCycle(
  messageId: string,
  text: string,
  stopReason = 'stop',
  errorMessage?: string,
): readonly Record<string, unknown>[] {
  const usage = { input: 10, output: 5, total: 15 }
  return [
    { type: 'message_start', messageId, message: { role: 'assistant' } },
    {
      type: 'message_update',
      messageId,
      assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
      message: { role: 'assistant', content: [] },
    },
    {
      type: 'message_update',
      messageId,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text },
    },
    {
      type: 'message_update',
      messageId,
      assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: text },
    },
    { type: 'message_end', messageId, message: assistantMessage(text, stopReason, usage, errorMessage) },
  ]
}

function emit(h: Harness, frames: readonly Record<string, unknown>[]): void {
  for (const frame of frames) h.rpc.receive(frame)
}

function settle(h: Harness, status: 'completed' | 'aborted' | 'error' = 'completed'): void {
  const prompt = promptOf(h)
  h.rpc.receive({
    type: 'prompt_result',
    id: prompt.id,
    agentInvoked: true,
    status,
    sessionSettled: true,
    ...status === 'error' ? { error: { message: 'provider failed' } } : {},
  })
}

/** Read a session back from disk through a fresh read handle. */
async function coldRead(ctx: Context, id: SessionId): Promise<readonly SessionEvent[]> {
  await ctx.sessionPersistence.flush()
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

function types(events: readonly SessionEvent[]): string[] {
  return events.map(event => event.type)
}

function userTurns(events: readonly SessionEvent[]): Extract<SessionEvent, { type: 'user/message' }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: 'user/message' }> => event.type === 'user/message')
}

function inboxSplices(events: readonly SessionEvent[]): Extract<SessionEvent, { type: 'agent/inbox/spliced' }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: 'agent/inbox/spliced' }> => event.type === 'agent/inbox/spliced')
}

describe('OmpAgentFactory runs one turn per human prompt', () => {
  it('projects a multi-step tool turn into one turn with two steps and no synthetic continue', async () => {
    const h = await harness()
    const created = await createAgent(h, 'session-factory-steps')
    created.agent.followup(userInput('read /tmp/a then answer'))
    await tick()
    acceptPrompt(h)
    emit(h, assistantCycle('m1', 'Reading it', 'toolUse'))
    h.rpc.receive({
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'read',
      args: { path: '/tmp/a' },
      intent: 'Reading /tmp/a',
    })
    h.rpc.receive({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'contents' }] },
      isError: false,
    })
    h.rpc.receive({ type: 'message_start', messageId: 'm2', message: { role: 'assistant' } })
    await tick()
    emit(h, assistantCycle('m2', 'Done').slice(1))
    settle(h)
    await created.agent.whenIdle()

    const events = created.agent.session.snapshotEvents()
    expect(types(events)).toEqual([
      'turn/start',
      'user/message',
      'step/start',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'step/start',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(1)
    const assistantMessages = events.filter((event): event is Extract<SessionEvent, { type: 'assistant/message' }> => event.type === 'assistant/message')
    expect(assistantMessages).toHaveLength(2)
    expect(assistantMessages[0]?.data.message.content).toEqual([
      { type: 'text', text: 'Reading it' },
      { type: 'tool-call', id: 'c1', name: 'read', arguments: JSON.stringify({ i: 'Reading /tmp/a', path: '/tmp/a' }) },
    ])
    expect(userTurns(events)).toHaveLength(1)
    expect(inboxSplices(events)).toEqual([])
    expect(h.toolCalls.map(event => event.kind)).toEqual(['start', 'end'])
    expect(JSON.stringify(events)).not.toContain('omp:continue')
    expect(JSON.stringify(events)).not.toContain('omp-continue')

    const stored = await coldRead(h.ctx, created.agent.id)
    expect(types(stored)).toEqual(types(events))
    const storedAssistant = stored.filter((event): event is Extract<SessionEvent, { type: 'assistant/message' }> => event.type === 'assistant/message')
    expect(storedAssistant[0]?.data.message.content[1]).toMatchObject({
      type: 'tool-call',
      arguments: JSON.stringify({ i: 'Reading /tmp/a', path: '/tmp/a' }),
    })
    await created.dispose()
  })

  it('sends a mid-step steer over the socket exactly once, between tool steps', async () => {
    const h = await harness()
    const created = await createAgent(h, 'session-factory-steer')
    created.agent.followup(userInput('start the long tool'))
    await tick()
    acceptPrompt(h)
    emit(h, assistantCycle('m1', 'Running', 'toolUse'))
    h.rpc.receive({
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'bash',
      args: { command: 'sleep 60' },
      intent: 'Waiting on the long tool',
    })
    await tick()

    created.agent.steer(userInput('also check the tests'))
    await tick()
    const steerFrames = h.rpc.written
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(frame => frame.type === 'steer')
    expect(steerFrames).toHaveLength(1)
    expect(steerFrames[0]).toMatchObject({ type: 'steer', message: 'also check the tests' })

    h.rpc.receive({
      type: 'message_end',
      messageId: 'echo-1',
      message: { role: 'user', content: [{ type: 'text', text: 'also check the tests' }] },
    })
    h.rpc.receive({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'done' }] },
      isError: false,
    })
    h.rpc.receive({ type: 'message_start', messageId: 'm2', message: { role: 'assistant' } })
    await tick()
    emit(h, assistantCycle('m2', 'Finished').slice(1))
    settle(h)
    await created.agent.whenIdle()

    const events = created.agent.session.snapshotEvents()
    const steers = userTurns(events)
    expect(steers).toHaveLength(2)
    expect(steers[1]?.data.content).toEqual([{ type: 'text', text: 'also check the tests' }])
    const stepStarts = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === 'step/start')
    expect(stepStarts).toHaveLength(2)
    const steerIndex = events.findIndex(event => event.type === 'user/message' && JSON.stringify(event.data).includes('also check the tests'))
    expect(steerIndex).toBeGreaterThan(stepStarts[0]?.index ?? 0)
    expect(steerIndex).toBeLessThan(stepStarts[1]?.index ?? 0)
    expect(inboxSplices(events).filter(splice => splice.data.outcome === 'canceled')).toEqual([])
    expect(h.rpc.written.filter(line => line.includes('"type":"steer"'))).toHaveLength(1)
    expect(h.rpc.written.filter(line => line.includes('"type":"prompt"'))).toHaveLength(1)
    await created.dispose()
  })

  it('detaches without aborting the OMP run, while a user cancel does abort', async () => {
    const detached = await harness()
    const first = await createAgent(detached, 'session-factory-detach')
    first.agent.followup(userInput('keep running'))
    await tick()
    acceptPrompt(detached)
    emit(detached, assistantCycle('m1', 'Working', 'toolUse'))
    detached.rpc.receive({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'sleep 5' } })
    await tick()
    await first.dispose()
    expect(detached.rpc.written.filter(line => line.includes('"type":"abort"'))).toEqual([])
    expect(detached.driver.hasActiveRun()).toBe(false)
    detached.driver.close()

    const cancelled = await harness()
    const second = await createAgent(cancelled, 'session-factory-cancel')
    second.agent.followup(userInput('stop this'))
    await tick()
    acceptPrompt(cancelled)
    emit(cancelled, assistantCycle('m1', 'Working', 'toolUse'))
    cancelled.rpc.receive({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'sleep 5' } })
    await tick()
    second.agent.cancel({ kind: 'user' })
    await second.agent.whenIdle()
    await tick()
    expect(cancelled.rpc.written.filter(line => line.includes('"type":"abort"'))).toHaveLength(1)
    const ends = second.agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
    expect(ends).toEqual([
      expect.objectContaining({ data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } }),
    ])
    await second.dispose()
  })

  it('keeps the user bubble above a turn that failed before OMP accepted the prompt', async () => {
    const h = await harness()
    const created = await createAgent(h, 'session-factory-error')
    created.agent.followup(userInput('this will fail'))
    await tick()
    const prompt = promptOf(h)
    h.rpc.receive({ type: 'response', id: prompt.id, command: 'prompt', success: false, error: 'provider unreachable' })
    await tick()
    await created.agent.whenIdle()

    const events = created.agent.session.snapshotEvents()
    expect(types(events)).toEqual(['turn/start', 'user/message', 'turn/end'])
    const end = events.at(-1)
    expect(end).toMatchObject({ type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
    const userIndex = events.findIndex(event => event.type === 'user/message')
    expect(userIndex).toBeGreaterThan(-1)
    expect(userIndex).toBeLessThan(events.length - 1)
    await created.dispose()
  })

  it('surfaces the exact provider error instead of ending the turn as completed', async () => {
    const h = await harness()
    const created = await createAgent(h, 'session-factory-provider-message-error')
    created.agent.followup(userInput('switch to deepseek'))
    await tick()
    acceptPrompt(h)
    emit(h, assistantCycle('m1', '', 'error', '400 Upstream request failed: Model is unavailable'))
    settle(h)
    await created.agent.whenIdle()

    const events = created.agent.session.snapshotEvents()
    const end = events.find(event => event.type === 'turn/end')
    expect(end?.data.reason).toEqual({
      kind: 'error',
      error: { message: '400 Upstream request failed: Model is unavailable', code: 'PROVIDER_ERROR' },
    })
    await created.dispose()
  })
})

describe('OmpAgentFactory keeps the harness request shape intact', () => {
  it('does not require agent-loop, llm-pi-ai, or a system prompt to drive a turn', async () => {
    const h = await harness()
    const created = await createAgent(h, 'session-factory-bare')
    created.agent.followup(userInput('hi'))
    await tick()
    acceptPrompt(h)
    emit(h, assistantCycle('m1', 'hello'))
    settle(h)
    await created.agent.whenIdle()
    expect(created.agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(1)
    await created.dispose()
  })

  it('exposes the durable inbox projection without canceling queued input', async () => {
    const h = await harness()
    const created = await createAgent(h, 'session-factory-inbox')
    const queued = userInput('queued while idle')
    created.agent.followup(userInput('first'))
    await tick()
    acceptPrompt(h)
    created.agent.followup(queued)
    emit(h, assistantCycle('m1', 'one'))
    settle(h)
    await tick()
    acceptPrompt(h)
    emit(h, assistantCycle('m2', 'two'))
    settle(h)
    await created.agent.whenIdle()
    const events = created.agent.session.snapshotEvents()
    expect(inboxSplices(events).filter(splice => splice.data.outcome === 'canceled')).toEqual([])
    expect(userTurns(events)).toHaveLength(2)
    await created.dispose()
  })
})

describe('OmpAgentFactory claims an idle external wake as its Turn opener', () => {
  const mail = '<hcom>[inform #41909] exo_lead -> argon: ship the wake rows</hcom>'
  const wake = { text: mail, source: { kind: 'omp-agent-message', form: 'relay' } } as const

  it('records the next-turn insert and claim around an idle wake so Chat promotes it', async () => {
    const h = await harness()
    const created = await createAgent(h, 'session-factory-idle-wake')
    expect(typeof created.agent.projectExternalWake).toBe('function')
    created.agent.projectExternalWake!(wake)
    await tick()

    const events = created.agent.session.snapshotEvents()
    const splices = inboxSplices(events).filter(splice => splice.data.target === 'next-turn')
    const opened = events.find(event => event.type === 'turn/start')
    const logged = userTurns(events)[0]
    const insert = splices.find(splice => splice.data.removedCount === undefined)
    const claim = splices.find(splice => splice.data.removedCount === 1)

    expect(logged?.data.source).toEqual({ kind: 'omp-agent-message', form: 'relay' })
    expect(logged?.data.content).toEqual([{ type: 'text', text: mail }])
    expect(insert, 'the wake is queued for the next Turn').toBeDefined()
    expect(claim, 'the waking Turn claims the queued mail').toBeDefined()
    expect(insert!.data.inserted.map(message => message.id)).toEqual([logged?.data.id])
    expect(claim!.data.inserted).toEqual([])
    expect(claim!.data.outcome).toBeUndefined()
    expect(insert!.seq).toBeLessThan(opened!.seq)
    expect(opened!.seq).toBeLessThan(claim!.seq)
    expect(claim!.seq).toBeLessThan(logged!.seq)

    await created.agent.whenIdle()
    await created.dispose()
  })

  it('keeps a wake that interrupts a running Turn out of the next-turn claim chain', async () => {
    const h = await harness()
    const created = await createAgent(h, 'session-factory-running-wake')
    created.agent.followup(userInput('start the long tool'))
    await tick()
    acceptPrompt(h)
    emit(h, assistantCycle('m1', 'Working', 'toolUse'))
    h.rpc.receive({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'sleep 60' } })
    await tick()

    created.agent.projectExternalWake!(wake)
    await tick()

    const events = created.agent.session.snapshotEvents()
    expect(inboxSplices(events).filter(splice => splice.data.target === 'next-turn')).toEqual([])
    expect(userTurns(events).map(event => event.data.source)).toEqual([
      { kind: 'user' },
      { kind: 'omp-agent-message', form: 'relay' },
    ])

    h.rpc.receive({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'done' }] },
      isError: false,
    })
    h.rpc.receive({ type: 'message_start', messageId: 'm2', message: { role: 'assistant' } })
    await tick()
    emit(h, assistantCycle('m2', 'Finished').slice(1))
    settle(h)
    await created.agent.whenIdle()
    await created.dispose()
  })
})

const builtLib = fileURLToPath(new URL('../lib/index.js', import.meta.url))

describe('OmpAgentFactory publishes the shared scope module', () => {
  it('tags the agent context with the agent as the shared scope key', async () => {
    const h = await harness()
    const created = await createAgent(h, 'session-factory-scope')
    expect(scopeOf(created.agent.ctx)).toBe(created.agent)
    await created.dispose()
  })

  it.skipIf(!existsSync(builtLib))('keeps dsh-scope and zod external in the built Host bundle', () => {
    const source = readFileSync(builtLib, 'utf8')
    expect(source).not.toContain('Symbol("dsh.scope")')
    expect(source).not.toMatch(/node_modules\/\.pnpm\/zod@/)
    expect(source).toMatch(/from\s+["']@deepseek-ai\/dsh-scope["']/)
    expect(source).toMatch(/from\s+["']zod["']/)
  })
})

function conversationTexts(events: readonly SessionEvent[]): string[] {
  return events
    .filter((event): event is Extract<SessionEvent, { type: 'user/message' }> =>
      event.type === 'user/message' && !isCompactCheckpointSource(event.data.source))
    .map(event => event.data.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
}

function inboxTexts(h: Harness, agent: Agent): string[] {
  return h.host.inbox(agent.session)()['next-turn']
    .map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
}

/**
 * Build the mirror shape the preserved backup recorded: a protected system head
 * in turn 1, a queued inbox splice, a trailing user message whose turn never
 * ended, and a compaction summary that shadows the protected head.
 */
async function corruptMirror(h: Harness, id: SessionId): Promise<{ path: string; header: SessionHeader }> {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    cwd: h.cwd,
    isSeeded: false,
    agentPreset: 'omp:argon',
  }
  const session = Session.create(id, [], header)
  session.append('session/title', {
    title: 'PLUG: Debug and restore CPA session crash',
    messageSeqs: [],
    source: { kind: 'user' },
  })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', {
    turn: 1,
    step: 1,
    message: createSystemMessage('You are Argon.'),
  }, { surfaceOp: 'append' })
  session.append('user/message', userInput('one'), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'reply 1' }],
      source: { provider: 'omp', model: 'omp' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('agent/inbox/spliced', {
    target: 'next-turn',
    start: 0,
    inserted: [userInput('queued while detached')],
  })
  session.append('turn/start', { turn: 2 })
  session.append('user/message', userInput('un-delivered prompt'), { surfaceOp: 'append' })

  const surface = [...session.surface.nodes]
  const compactionId = CompactionId('omp-corrupt')
  session.append('compaction/start', { compactionId, turn: 2 })
  session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text', text: 'Earlier turns summarized' }],
    shadowedRange: { start: surface[0]!, end: surface.at(-1)! },
    shadowedSeqs: surface,
    shadowedTokenCount: 5000,
    provider: 'omp',
    model: 'omp',
  })

  const handle = await h.ctx.sessionPersistence.create(header)
  try {
    await handle.append(session.snapshotEvents())
  } finally {
    await handle.close()
  }
  await h.ctx.sessionPersistence.flush()
  const snapshot = await h.ctx.sessionPersistence.stat(id)
  const path = snapshot?.location?.path
  if (path === undefined) throw new Error('the corrupt artifact has no resolved location path')
  return { path, header }
}

async function recoveryTranscript(h: Harness): Promise<{ path: string; cursor: OmpHydrationCursor }> {
  const sessionId = '01a0c88e-7521-7000-bb6a-67527d2b6806'
  const cwd = dirname(h.cwd)
  const path = join(cwd, 'recovery-transcript.jsonl')
  await writeFile(path, [
    { type: 'title', v: 1, title: 'PLUG: Debug and restore CPA session crash' },
    { type: 'session', version: 3, id: sessionId, cwd },
    { type: 'message', id: '00000001', parentId: sessionId, message: { role: 'user', content: [{ type: 'text', text: 'one' }] } },
    { type: 'message', id: '00000002', parentId: '00000001', message: { role: 'assistant', content: [{ type: 'text', text: 'reply 1' }] } },
  ].map(line => JSON.stringify(line)).join('\n') + '\n')
  const { size } = await stat(path)
  return { path, cursor: { hydratedTurns: 1, hydratedLeafEntryId: '00000002', hydratedByteOffset: size } }
}

describe('OmpAgentFactory recovers a corrupt session-format mirror', () => {
  it('quarantines the artifact, keeps identity and undelivered input, and never replays hydrated history', async () => {
    let recoveries = 0
    let transcriptPath = ''
    let cursor: OmpHydrationCursor | undefined
    const h = await harness({
      hydrate: async (agent) => {
        if (transcriptPath === '') return
        await hydrateOmpSession(agent.session, transcriptPath, Number.POSITIVE_INFINITY, cursor)
      },
      recover: async (ctx, id, failure) => {
        recoveries += 1
        return await quarantineCorruptSession(ctx, id, failure)
      },
    })
    const prepared = await recoveryTranscript(h)
    transcriptPath = prepared.path
    cursor = prepared.cursor
    const id = SessionId('session-corrupt-recovery')
    await corruptMirror(h, id)

    const resumed = await h.ctx.agents.resume({ resumeSessionId: id })

    expect(recoveries).toBe(1)
    expect(resumed.agent.id).toBe(id)
    const events = resumed.agent.session.snapshotEvents()
    expect(resumed.agent.session.header).toMatchObject({ cwd: h.cwd, agentPreset: 'omp:argon' })
    expect(conversationTexts(events)).toEqual(['one', 'un-delivered prompt'])
    expect(inboxSplices(events)).toHaveLength(1)
    expect(inboxTexts(h, resumed.agent)).toEqual(['queued while detached'])

    await resumed.dispose()
    const again = await h.ctx.agents.resume({ resumeSessionId: id })
    const replayed = again.agent.session.snapshotEvents()
    expect(conversationTexts(replayed)).toEqual(['one', 'un-delivered prompt'])
    expect(inboxSplices(replayed)).toHaveLength(1)
    expect(inboxTexts(h, again.agent)).toEqual(['queued while detached'])
    await again.dispose()
  })

  it('renames the corrupt artifact and returns its header', async () => {
    const h = await harness()
    const id = SessionId('session-quarantine-helper')
    const artifact = await corruptMirror(h, id)
    const original = await readFile(artifact.path)

    let failure: unknown
    try {
      await h.ctx.sessionPersistence.open(id, 'read')
    } catch (error: unknown) {
      failure = error
    }
    expect(failure).toMatchObject({ name: 'SessionPersistenceCorruptionError' })

    const header = await quarantineCorruptSession(h.ctx, id, failure as Error)

    expect(header).toMatchObject({ id, cwd: h.cwd, agentPreset: 'omp:argon' })
    await expect(stat(artifact.path)).rejects.toMatchObject({ code: 'ENOENT' })
    const dir = dirname(artifact.path)
    const quarantined = (await readdir(dir)).filter(name => name.startsWith(`${basename(artifact.path)}.corrupt-`))
    expect(quarantined).toHaveLength(1)
    expect(await readFile(join(dir, quarantined[0]!))).toEqual(original)
  })
})

const MEASURED_TITLE = 'PLUG: measured recovery'
const MEASURED_OMP_SESSION = '01a0c88e-7521-7000-bb6a-67527d2b6f00'

/**
 * Build the mirror shape a real 488-turn session persisted: 413 `turn/start`
 * events with 412 unique turns, the first one turn 87, and turn 488 twice. Raw
 * JSONL is required because no valid Session can append a start at turn 87.
 */
async function measuredCorruptMirror(h: Harness, id: SessionId): Promise<{ path: string; original: Buffer }> {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    cwd: h.cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'omp:argon',
  }
  const seed = Session.create(id, [], header)
  seed.append('session/title', { title: MEASURED_TITLE, messageSeqs: [], source: { kind: 'user' } })
  const handle = await h.ctx.sessionPersistence.create(header)
  try {
    await handle.append(seed.snapshotEvents())
  } finally {
    await handle.close()
  }
  const snapshot = await h.ctx.sessionPersistence.stat(id)
  const path = snapshot?.location?.path
  if (path === undefined) throw new Error('the measured artifact has no resolved location path')

  const turnNumbers = Array.from({ length: 412 }, (_, index) => 87 + index)
  const duplicated = turnNumbers.flatMap(turn => turn === 488 ? [turn, turn] : [turn])
  const rows: unknown[] = [
    { type: 'session', ...header },
    { type: 'session/title', seq: 0, time: 1, data: { title: MEASURED_TITLE, messageSeqs: [], source: { kind: 'user' } } },
  ]
  let seq = 1
  for (const turn of duplicated) {
    rows.push({ type: 'turn/start', seq, time: seq + 1, data: { turn } })
    seq += 1
    rows.push({ type: 'turn/end', seq, time: seq + 1, data: { turn, reason: { kind: 'completed' } } })
    seq += 1
  }
  const original = Buffer.from(`${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
  await writeFile(path, original)
  return { path, original }
}

async function measuredTranscript(h: Harness, turns: number): Promise<string> {
  const path = join(dirname(h.cwd), 'measured-transcript.jsonl')
  const rows: unknown[] = [
    { type: 'title', v: 1, title: MEASURED_TITLE },
    { type: 'session', version: 3, id: MEASURED_OMP_SESSION, cwd: dirname(h.cwd) },
  ]
  for (let turn = 1; turn <= turns; turn += 1) {
    const user = (turn * 2 - 1).toString(16).padStart(8, '0')
    const assistant = (turn * 2).toString(16).padStart(8, '0')
    const parent = turn === 1 ? MEASURED_OMP_SESSION : (turn * 2 - 2).toString(16).padStart(8, '0')
    rows.push({
      type: 'message',
      id: user,
      parentId: parent,
      message: { role: 'user', content: [{ type: 'text', text: `measured turn ${String(turn)}` }] },
    })
    rows.push({
      type: 'message',
      id: assistant,
      parentId: user,
      message: { role: 'assistant', content: [{ type: 'text', text: `measured reply ${String(turn)}` }] },
    })
  }
  await writeFile(path, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
  return path
}

describe('OmpAgentFactory recovers the measured corrupt mirror shape', () => {
  it('rehydrates a bound mirror from turn 1 into a released-valid artifact', async () => {
    let store: OmpBindings | undefined
    const h = await harness({
      hydrate: async (agent) => {
        const bindings = store
        const binding = await bindings?.get(agent.id)
        if (bindings === undefined || binding === undefined) return
        await hydrateOmpBinding({ bindings, session: agent.session, binding })
      },
      recover: async (ctx, id, failure) => quarantineCorruptSession(ctx, id, failure, store),
    })
    store = new OmpBindings(join(h.cwd, 'bindings.json'))
    const turns = 5
    const transcriptPath = await measuredTranscript(h, turns)
    const id = SessionId('session-measured-corrupt')
    const fixture = await measuredCorruptMirror(h, id)
    await store.set(id, {
      ompSessionId: MEASURED_OMP_SESSION,
      path: transcriptPath,
      cwd: dirname(h.cwd),
      profile: 'argon',
      hydratedTurns: 488,
      hydratedLeafEntryId: (turns * 2).toString(16).padStart(8, '0'),
      hydratedByteOffset: (await stat(transcriptPath)).size,
      updatedAt: new Date(0).toISOString(),
    })

    const resumed = await h.ctx.agents.resume({ resumeSessionId: id })
    const events = resumed.agent.session.snapshotEvents()
    const starts = events.flatMap(event => event.type === 'turn/start' ? [event.data.turn] : [])
    expect(starts[0]).toBe(1)
    expect(new Set(starts).size).toBe(starts.length)
    expect(events[2]).toMatchObject({ type: 'turn/start', seq: 2, data: { turn: 1 } })
    expect(conversationTexts(events)).toEqual(
      Array.from({ length: turns }, (_, index) => `measured turn ${String(index + 1)}`),
    )
    await resumed.dispose()
    expect((await store.get(id))?.hydratedTurns).toBe(turns)

    const dir = dirname(fixture.path)
    const quarantined = (await readdir(dir)).filter(name => name.startsWith(`${basename(fixture.path)}.corrupt-`))
    expect(quarantined).toHaveLength(1)
    expect(await readFile(join(dir, quarantined[0]!))).toEqual(fixture.original)

    const replacement = await h.ctx.sessionPersistence.stat(id)
    expect(replacement?.location?.path).toBe(fixture.path)
    const header = replacement?.header
    if (header === undefined) throw new Error('the recovered mirror has no header')
    const stored = await coldRead(h.ctx, id)
    expect(() => assertReleasedV4Relationships(
      { header, inheritedEventCount: 0, events: stored } as unknown as Parameters<typeof assertReleasedV4Relationships>[0],
      KNOWN_SESSION_EVENT_TYPES,
    )).not.toThrow()
  })


  it('rebuilds a bound mirror for a viewer read without attaching an agent', async () => {
    const h = await harness()
    const store = new OmpBindings(join(h.cwd, 'bindings-viewer.json'))
    const turns = 4
    const transcriptPath = await measuredTranscript(h, turns)
    const id = SessionId('session-viewer-recovered')
    const fixture = await measuredCorruptMirror(h, id)
    await store.set(id, {
      ompSessionId: MEASURED_OMP_SESSION,
      path: transcriptPath,
      cwd: dirname(h.cwd),
      hydratedTurns: 86,
      hydratedLeafEntryId: (turns * 2).toString(16).padStart(8, '0'),
      hydratedByteOffset: (await stat(transcriptPath)).size,
      updatedAt: new Date(0).toISOString(),
    })
    const corrupt = await h.ctx.sessionPersistence.open(id, 'read')
      .then(() => undefined, (error: unknown) => error)
    expect(corrupt).toBeInstanceOf(Error)

    expect(await recoverBoundMirror(h.ctx, store, id, corrupt as Error)).toBe(true)

    const events = await coldRead(h.ctx, id)
    const starts = events.flatMap(event => event.type === 'turn/start' ? [event.data.turn] : [])
    expect(starts).toEqual([1, 2, 3, 4])
    expect(new Set(starts).size).toBe(turns)
    const firstPrompt = events.find(event => event.type === 'user/message')
    const block = firstPrompt?.type === 'user/message' ? firstPrompt.data.content[0] : undefined
    expect(block?.type === 'text' ? block.text : undefined).toBe('measured turn 1')
    expect((await store.get(id))?.hydratedTurns).toBe(turns)
    const quarantined = (await readdir(dirname(fixture.path))).filter(name => name.startsWith(`${basename(fixture.path)}.corrupt-`))
    expect(quarantined).toHaveLength(1)
    const header = (await h.ctx.sessionPersistence.stat(id))?.header
    expect(() => assertReleasedV4Relationships(
      { header, inheritedEventCount: 0, events } as unknown as Parameters<typeof assertReleasedV4Relationships>[0],
      KNOWN_SESSION_EVENT_TYPES,
    )).not.toThrow()
  })

  it('leaves an unbound corrupt artifact in place and refuses the read', async () => {
    const h = await harness({
      recover: async (ctx, id, failure) => quarantineCorruptSession(
        ctx, id, failure, new OmpBindings(join(h.cwd, 'bindings-unbound.json')),
      ),
    })
    const id = SessionId('session-measured-unbound')
    const fixture = await measuredCorruptMirror(h, id)

    let failure: Error | undefined
    try {
      await h.ctx.agents.resume({ resumeSessionId: id })
    } catch (error: unknown) {
      failure = error instanceof Error ? error : undefined
    }
    expect(failure?.name).toBe('SessionPersistenceCorruptionError')
    expect((await stat(fixture.path)).isFile()).toBe(true)
    const siblings = await readdir(dirname(fixture.path))
    expect(siblings.filter(name => name.includes('.corrupt-'))).toEqual([])
    expect(await readFile(fixture.path)).toEqual(fixture.original)
  })

  it('replays the whole transcript when a salvaged prefix precedes a stale cursor', async () => {
    const h = await harness()
    const store = new OmpBindings(join(h.cwd, 'bindings-salvaged.json'))
    const turns = 6
    const transcriptPath = await measuredTranscript(h, turns)
    const id = SessionId('session-salvaged-prefix')
    const fixture = await measuredCorruptMirror(h, id)
    await store.set(id, {
      ompSessionId: MEASURED_OMP_SESSION,
      path: transcriptPath,
      cwd: dirname(h.cwd),
      hydratedTurns: 488,
      hydratedLeafEntryId: (turns * 2).toString(16).padStart(8, '0'),
      hydratedByteOffset: (await stat(transcriptPath)).size,
      updatedAt: new Date(0).toISOString(),
    })
    const donor = Session.create(SessionId('salvaged-donor'), [], {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('salvaged-donor'),
      createdAt: 1,
      cwd: h.cwd,
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: 'omp:argon',
    })
    for (let turn = 1; turn <= 3; turn += 1) {
      donor.append('turn/start', { turn })
      donor.append('user/message', userInput(`salvaged prefix ${String(turn)}`), { surfaceOp: 'append' })
      donor.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    const salvaged = donor.snapshotEvents()
    const failure = new SessionPersistenceCorruptionError('stored prefix failed validation', {
      cause: new Error('SessionLogRelationshipError: turn/start does not open the expected turn'),
      salvagedEvents: salvaged,
    })

    expect(await recoverBoundMirror(h.ctx, store, id, failure)).toBe(true)

    const events = await coldRead(h.ctx, id)
    const starts = events.flatMap(event => event.type === 'turn/start' ? [event.data.turn] : [])
    expect(starts).toEqual([1, 2, 3, 4, 5, 6])
    expect(conversationTexts(events)).toEqual(
      Array.from({ length: turns }, (_, index) => `measured turn ${String(index + 1)}`),
    )
    expect((await store.get(id))?.hydratedTurns).toBe(turns)
    const quarantined = (await readdir(dirname(fixture.path))).filter(name => name.startsWith(`${basename(fixture.path)}.corrupt-`))
    expect(quarantined).toHaveLength(1)
  })

  it('refuses recovery when the transcript header names another session and keeps the artifact', async () => {
    const h = await harness()
    const store = new OmpBindings(join(h.cwd, 'bindings-mismatch.json'))
    const transcriptPath = join(dirname(h.cwd), 'mismatched-transcript.jsonl')
    await writeFile(transcriptPath, `${JSON.stringify({ type: 'session', version: 3, id: 'another-omp-session', cwd: dirname(h.cwd) })}\n`)
    const id = SessionId('session-transcript-mismatch')
    const fixture = await measuredCorruptMirror(h, id)
    const cursor = {
      ompSessionId: MEASURED_OMP_SESSION,
      path: transcriptPath,
      cwd: dirname(h.cwd),
      hydratedTurns: 488,
      hydratedLeafEntryId: '00000004',
      hydratedByteOffset: 128,
      updatedAt: new Date(0).toISOString(),
    } as const
    await store.set(id, cursor)
    const corrupt = await h.ctx.sessionPersistence.open(id, 'read')
      .then(() => undefined, (error: unknown) => error)

    expect(await recoverBoundMirror(h.ctx, store, id, corrupt as Error)).toBe(false)

    expect(await readFile(fixture.path)).toEqual(fixture.original)
    const siblings = await readdir(dirname(fixture.path))
    expect(siblings.filter(name => name.includes('.corrupt-'))).toEqual([])
    expect(await store.get(id)).toMatchObject({ hydratedTurns: 488, hydratedLeafEntryId: '00000004' })
  })

  it('restores the quarantined artifact when writing the replacement fails', async () => {
    const h = await harness()
    const store = new OmpBindings(join(h.cwd, 'bindings-rollback.json'))
    const turns = 4
    const transcriptPath = await measuredTranscript(h, turns)
    const id = SessionId('session-viewer-rollback')
    const fixture = await measuredCorruptMirror(h, id)
    await store.set(id, {
      ompSessionId: MEASURED_OMP_SESSION,
      path: transcriptPath,
      cwd: dirname(h.cwd),
      hydratedTurns: 488,
      hydratedLeafEntryId: (turns * 2).toString(16).padStart(8, '0'),
      hydratedByteOffset: (await stat(transcriptPath)).size,
      updatedAt: new Date(0).toISOString(),
    })
    const persistence = h.ctx.sessionPersistence
    const create = persistence.create.bind(persistence)
    persistence.create = async () => {
      throw new Error('replacement write refused')
    }
    const corrupt = await persistence.open(id, 'read')
      .then(() => undefined, (error: unknown) => error)

    expect(await recoverBoundMirror(h.ctx, store, id, corrupt as Error)).toBe(false)
    persistence.create = create

    expect(await readFile(fixture.path)).toEqual(fixture.original)
    const siblings = await readdir(dirname(fixture.path))
    expect(siblings.filter(name => name.includes('.corrupt-'))).toEqual([])
    expect((await store.get(id))?.hydratedTurns).toBe(488)
  })
})

