import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { modelSelectionProjectionDefinition, type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OmpAgentFactory,
  inboxProjectionDefinition,
  type OmpAgentHost,
} from '../src/agent-factory.ts'
import { OmpAgentDriver, type OmpToolEvent } from '../src/driver.ts'
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

async function harness(): Promise<Harness> {
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
      pluginCtx.agents.setFactory(new OmpAgentFactory({ ctx: pluginCtx, host }))
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

function assistantMessage(text: string, stopReason: string, usage: Record<string, number>): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason,
    usage: { input: usage.input, output: usage.output, totalTokens: usage.total },
  }
}

function assistantCycle(messageId: string, text: string, stopReason = 'stop'): readonly Record<string, unknown>[] {
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
    { type: 'message_end', messageId, message: assistantMessage(text, stopReason, usage) },
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

function userTurns(events: readonly SessionEvent[]): SessionEvent[] {
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

