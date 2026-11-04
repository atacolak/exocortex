import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { OmpAgentDriver, OmpEventTranslator, pureUserTurns } from '../src/driver.ts'
import type { OmpAgentEvent, OmpRpcCommand, OmpRpcFrame } from '../src/types.ts'

class FakeClient {
  readonly commands: OmpRpcCommand[] = []
  private readonly listeners = new Set<(frame: OmpRpcFrame) => void>()
  private readonly pending: Array<(value: unknown) => void> = []

  request(command: OmpRpcCommand): Promise<unknown> {
    this.commands.push(command)
    return new Promise((resolve) => { this.pending.push(resolve) })
  }

  onFrame(listener: (frame: OmpRpcFrame) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(frame: OmpAgentEvent): void {
    for (const listener of [...this.listeners]) listener(frame)
  }

  settle(value: unknown = {}): void {
    const next = this.pending.shift()
    if (next === undefined) throw new Error('no pending OMP command')
    next(value)
  }

  promptText(index: number): string {
    const prompt = this.commands.filter(command => command.type === 'prompt')[index]
    return String(prompt?.message)
  }
}

const tick = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

function promptId(client: FakeClient): string | undefined {
  return client.commands.filter(command => command.type === 'prompt').at(-1)?.id
}

function settlePrompt(client: FakeClient, status: 'completed' | 'aborted' | 'error' = 'completed', message?: string): void {
  client.emit({
    type: 'prompt_result',
    id: promptId(client),
    agentInvoked: true,
    status,
    sessionSettled: true,
    ...message === undefined ? {} : { error: { message } },
  })
}

function request(messages: GenerateOptions['messages']): GenerateOptions {
  return { provider: 'omp', model: 'omp', messages }
}

const user = (id: string, text: string): GenerateOptions['messages'][number] => ({
  role: 'user',
  content: [{ type: 'text', text }],
  id: id as never,
  source: { kind: 'user' },
})

const assistant = (id: string, text: string): GenerateOptions['messages'][number] => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  id: id as never,
  source: { kind: 'model', provider: 'omp', model: 'omp' },
})

function messageUpdate(messageId: string, assistantMessageEvent: object, message: object): OmpAgentEvent {
  return { type: 'message_update', messageId, assistantMessageEvent, message }
}


function assistantMessage(text: string, stopReason: string, usage: object): object {
  return { role: 'assistant', content: [{ type: 'text', text }], stopReason, usage }
}

describe('OmpEventTranslator', () => {
  it('streams text deltas as one text block and settles from the final message', () => {
    const translator = new OmpEventTranslator()
    const usage = { input: 12, output: 3, cacheRead: 4, cacheWrite: 0, totalTokens: 19 }
    const chunks = [
      ...translator.push(messageUpdate('m1', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', usage))),
      ...translator.push(messageUpdate('m1', { type: 'text_delta', contentIndex: 0, delta: 'Hel' }, assistantMessage('Hel', 'stop', usage))),
      ...translator.push(messageUpdate('m1', { type: 'text_delta', contentIndex: 0, delta: 'lo' }, assistantMessage('Hello', 'stop', usage))),
      ...translator.push(messageUpdate('m1', { type: 'text_end', contentIndex: 0, content: 'Hello' }, assistantMessage('Hello', 'stop', usage))),
      ...translator.finish(),
    ]
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 0, totalTokens: 19 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('keeps thinking and reply text in separate blocks', () => {
    const translator = new OmpEventTranslator()
    const message = (thinking: string, text: string): object => ({
      role: 'assistant',
      content: [{ type: 'thinking', thinking }, { type: 'text', text }],
      stopReason: 'stop',
      usage: { input: 1, output: 2 },
    })
    const chunks = [
      ...translator.push(messageUpdate('m2', { type: 'thinking_start', contentIndex: 0 }, message('', ''))),
      ...translator.push(messageUpdate('m2', { type: 'thinking_delta', contentIndex: 0, delta: 'plan' }, message('plan', ''))),
      ...translator.push(messageUpdate('m2', { type: 'thinking_end', contentIndex: 0, content: 'plan' }, message('plan', ''))),
      ...translator.push(messageUpdate('m2', { type: 'text_start', contentIndex: 1 }, message('plan', ''))),
      ...translator.push(messageUpdate('m2', { type: 'text_delta', contentIndex: 1, delta: 'done' }, message('plan', 'done'))),
      ...translator.push(messageUpdate('m2', { type: 'text_end', contentIndex: 1, content: 'done' }, message('plan', 'done'))),
      ...translator.finish(),
    ]
    expect(chunks.filter(chunk => chunk.type === 'block-start')).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'block-start', index: 1, blockType: 'text' },
    ])
    expect(chunks.filter(chunk => chunk.type === 'block-end')).toEqual([
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'plan' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'done' } },
    ])
  })

  it('drops tool-call blocks OMP already executed and settles a tool-use stop as stop', () => {
    const translator = new OmpEventTranslator()
    const message = (): object => ({
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/tmp' } }],
      stopReason: 'toolUse',
      usage: { input: 1, output: 1 },
    })
    const chunks = [
      ...translator.push(messageUpdate('m3', { type: 'toolcall_start', contentIndex: 0 }, message())),
      ...translator.push(messageUpdate('m3', { type: 'toolcall_delta', contentIndex: 0, delta: '{"path"' }, message())),
      ...translator.push(messageUpdate('m3', { type: 'toolcall_end', contentIndex: 0 }, message())),
      ...translator.finish(),
    ]
    expect(chunks).toEqual([
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('reports an errored run with the process failure text', () => {
    const translator = new OmpEventTranslator()
    const chunks = [
      ...translator.push(messageUpdate('m4', {
        type: 'error',
        reason: 'error',
        error: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'upstream exploded', usage: { input: 2, output: 0 } },
      }, {})),
      ...translator.finish({ status: 'error', message: 'upstream exploded' }),
    ]
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'PROVIDER_ERROR', message: 'upstream exploded' } },
    })
  })

  it('continues through per-message done events and settles once for the run', () => {
    const translator = new OmpEventTranslator()
    const first = [
      ...translator.push(messageUpdate('m5', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'toolUse', { input: 1, output: 1 }))),
      ...translator.push(messageUpdate('m5', { type: 'text_delta', contentIndex: 0, delta: 'step one' }, assistantMessage('step one', 'toolUse', { input: 1, output: 1 }))),
      ...translator.push(messageUpdate('m5', { type: 'text_end', contentIndex: 0, content: 'step one' }, assistantMessage('step one', 'toolUse', { input: 1, output: 1 }))),
      ...translator.push(messageUpdate('m5', { type: 'done', reason: 'toolUse', message: assistantMessage('step one', 'toolUse', { input: 1, output: 1 }) }, assistantMessage('step one', 'toolUse', { input: 1, output: 1 }))),
    ]
    expect(first.filter(chunk => chunk.type === 'finish')).toEqual([])
    const second = [
      ...translator.push(messageUpdate('m6', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', { input: 2, output: 2 }))),
      ...translator.push(messageUpdate('m6', { type: 'text_delta', contentIndex: 0, delta: 'step two' }, assistantMessage('step two', 'stop', { input: 2, output: 2 }))),
      ...translator.push(messageUpdate('m6', { type: 'text_end', contentIndex: 0, content: 'step two' }, assistantMessage('step two', 'stop', { input: 2, output: 2 }))),
      ...translator.push(messageUpdate('m6', { type: 'done', reason: 'stop', message: assistantMessage('step two', 'stop', { input: 2, output: 2 }) }, assistantMessage('step two', 'stop', { input: 2, output: 2 }))),
      ...translator.finish({ status: 'completed' }),
    ]
    expect(second.filter(chunk => chunk.type === 'block-end')).toEqual([
      { type: 'block-end', index: 1, block: { type: 'text', text: 'step two' } },
    ])
    expect(second.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})

describe('pureUserTurns', () => {
  it('keeps real user prose and images and drops assembled context and echoes', () => {
    const image = {
      type: 'image' as const,
      attachment: { attachmentId: 'img-1' as never, mediaType: 'image/png' as const, bytes: 68, width: 1, height: 1 },
    }
    const messages: GenerateOptions['messages'] = [
      user('u1', 'first'),
      { role: 'user', id: 'ctx' as never, content: [{ type: 'text', text: '<current_runtime_context>no</current_runtime_context>' }], source: { kind: 'runtime-context' } },
      assistant('a1', 'reply'),
      { role: 'user', id: 'u2' as never, content: [{ type: 'text', text: 'look [Image #1]' }, image], source: { kind: 'user' } },
    ]
    expect(pureUserTurns(messages)).toEqual([
      { key: 'id:u1', text: 'first', images: [] },
      { key: 'id:u2', text: 'look [Image #1]', images: [image.attachment] },
    ])
  })
})

describe('OmpAgentDriver', () => {
  it('replays the history once and then sends only new messages', async () => {
    const client = new FakeClient()
    const driver = new OmpAgentDriver(client)
    const first = request([user('u1', 'hello')])

    const consume = (async () => {
      const chunks: StreamChunk[] = []
      for await (const chunk of driver.stream(first, new AbortController().signal)) chunks.push(chunk)
      return chunks
    })()
    await tick()
    client.settle()
    await tick()
    client.emit(messageUpdate('m1', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('m1', { type: 'text_delta', contentIndex: 0, delta: 'hi' }, assistantMessage('hi', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('m1', { type: 'text_end', contentIndex: 0, content: 'hi' }, assistantMessage('hi', 'stop', { input: 1, output: 1 })))
    settlePrompt(client)
    const chunks = await consume

    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(client.commands.map(command => command.type)).toEqual(['prompt'])
    expect(client.promptText(0)).toBe('hello')

    const second = request([...first.messages, assistant('a1', 'hi'), user('u2', 'again')])
    const consumeAgain = (async () => {
      for await (const _chunk of driver.stream(second, new AbortController().signal)) { /* drain */ }
    })()
    await tick()
    client.emit(messageUpdate('m2', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('m2', { type: 'text_end', contentIndex: 0, content: 'ok' }, assistantMessage('ok', 'stop', { input: 1, output: 1 })))
    client.settle()
    settlePrompt(client)
    await consumeAgain
    expect(client.commands.filter(command => command.type === 'new_session')).toHaveLength(0)
    expect(client.promptText(1)).toBe('again')
  })

  it('steers a prompt when OMP is already processing a background wake', async () => {
    const client = new FakeClient()
    const driver = new OmpAgentDriver(client)
    const consume = (async () => {
      for await (const _chunk of driver.stream(request([user('u1', 'wake reply')]), new AbortController().signal)) { /* drain */ }
    })()
    await tick()

    expect(client.commands.find(command => command.type === 'prompt')).toMatchObject({
      type: 'prompt',
      message: 'wake reply',
      streamingBehavior: 'steer',
    })
    client.settle()
    settlePrompt(client)
    await consume
  })

  it('restarts a replay session when the assembled history shrinks', async () => {
    const client = new FakeClient()
    const driver = new OmpAgentDriver(client)
    const first = request([user('u1', 'one'), assistant('a1', 'two'), user('u2', 'three')])
    const consume = (async () => {
      for await (const _chunk of driver.stream(first, new AbortController().signal)) { /* drain */ }
    })()
    await tick()
    client.settle()
    await tick()
    client.emit(messageUpdate('m1', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('m1', { type: 'text_end', contentIndex: 0, content: 'ok' }, assistantMessage('ok', 'stop', { input: 1, output: 1 })))
    settlePrompt(client)
    await consume

    const compacted = request([user('u9', 'fresh start')])
    const consumeCompacted = (async () => {
      for await (const _chunk of driver.stream(compacted, new AbortController().signal)) { /* drain */ }
    })()
    await tick()
    client.settle()
    await tick()
    client.emit(messageUpdate('m2', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('m2', { type: 'text_end', contentIndex: 0, content: 'ok' }, assistantMessage('ok', 'stop', { input: 1, output: 1 })))
    client.settle()
    settlePrompt(client)
    await consumeCompacted
    expect(client.commands.filter(command => command.type === 'new_session')).toHaveLength(1)
    expect(client.promptText(1)).toBe('fresh start')
  })

  it('sends only the newest user message when attaching to an existing session', async () => {
    const client = new FakeClient()
    const driver = new OmpAgentDriver(client, { transcript: 'latest' })
    const attached = request([user('u1', 'old'), assistant('a1', 'old reply'), user('u2', 'new question')])
    const consume = (async () => {
      for await (const _chunk of driver.stream(attached, new AbortController().signal)) { /* drain */ }
    })()
    await tick()
    client.settle()
    client.emit(messageUpdate('m1', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('m1', { type: 'text_end', contentIndex: 0, content: 'ok' }, assistantMessage('ok', 'stop', { input: 1, output: 1 })))
    settlePrompt(client)
    await consume
    expect(client.commands.map(command => command.type)).toEqual(['prompt'])
    expect(client.promptText(0)).toBe('new question')
  })

  it('settles an errored run from prompt_result even without a terminal message error', async () => {
    const client = new FakeClient()
    const driver = new OmpAgentDriver(client)
    const consume = (async () => {
      const chunks: StreamChunk[] = []
      for await (const chunk of driver.stream(request([user('u1', 'hello')]), new AbortController().signal)) chunks.push(chunk)
      return chunks
    })()
    await tick()
    client.settle()
    settlePrompt(client, 'error', 'gateway overloaded')
    const chunks = await consume
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'PROVIDER_ERROR', message: 'gateway overloaded' } },
    })
  })

  it('closes a local-only prompt from its agentInvoked response', async () => {
    const client = new FakeClient()
    const driver = new OmpAgentDriver(client)
    const consume = (async () => {
      const chunks: StreamChunk[] = []
      for await (const chunk of driver.stream(request([user('u1', '/status')]), new AbortController().signal)) chunks.push(chunk)
      return chunks
    })()
    await tick()
    client.settle({ agentInvoked: false })
    const chunks = await consume
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })

  it('steers an active run before its open tool finishes and sends once', async () => {
    const client = new FakeClient()
    const driver = new OmpAgentDriver(client)
    const first = (async () => {
      for await (const _chunk of driver.stream(request([user('u1', 'start a long tool')]), new AbortController().signal)) { /* drain */ }
    })()
    await tick()
    client.settle()
    client.emit({ type: 'tool_execution_start', toolCallId: 't-1', toolName: 'bash', args: { command: 'sleep 60' } })

    const steering = driver.steerImmediate([user('u2', 'stop and summarize')])
    await tick()
    expect(client.commands.filter(command => command.type === 'steer')).toEqual([
      { type: 'steer', message: 'stop and summarize' },
    ])

    client.settle()
    await steering
    client.emit({ type: 'tool_execution_end', toolCallId: 't-1', toolName: 'bash', result: { content: [] }, isError: false })
    settlePrompt(client)
    await first

    const second = (async () => {
      for await (const _chunk of driver.stream(request([user('u1', 'start a long tool'), user('u2', 'stop and summarize')]), new AbortController().signal)) { /* drain */ }
    })()
    await tick()
    await second
    expect(client.commands.filter(command => command.type === 'steer')).toHaveLength(1)
  })

  it('projects OMP tool executions in order', async () => {
    const client = new FakeClient()
    const events: unknown[] = []
    const driver = new OmpAgentDriver(client, { onTool: (batch) => { events.push(...batch) } })
    const consume = (async () => {
      for await (const _chunk of driver.stream(request([user('u1', 'use a tool')]), new AbortController().signal)) { /* drain */ }
    })()
    await tick()
    client.settle()
    client.emit({ type: 'tool_execution_start', toolCallId: 't-1', toolName: 'cordis_inspect_list', args: { platform: 'host' }, intent: 'Inspecting host surface' })
    client.emit({ type: 'tool_execution_end', toolCallId: 't-1', toolName: 'cordis_inspect_list', result: { content: [{ type: 'text', text: '[]' }] }, isError: false })
    settlePrompt(client)
    await consume
    expect(events).toEqual([
      { kind: 'start', toolCallId: 't-1', toolName: 'cordis_inspect_list', arguments: { i: 'Inspecting host surface', platform: 'host' } },
      { kind: 'end', toolCallId: 't-1', toolName: 'cordis_inspect_list', content: [{ type: 'text', text: '[]' }], isError: false },
    ])
  })

  it('never aborts the live OMP run when a teardown signal fires', async () => {
    const client = new FakeClient()
    const driver = new OmpAgentDriver(client)
    const controller = new AbortController()
    const consume = (async () => {
      for await (const _chunk of driver.stream(request([user('u1', 'hello')]), controller.signal)) { /* drain */ }
    })()
    await tick()
    client.settle()

    controller.abort({ kind: 'disposed' })
    await consume

    expect(client.commands.filter(command => command.type === 'abort')).toEqual([])
  })

  it('aborts the live OMP run when the operator cancels the step', async () => {
    const client = new FakeClient()
    const driver = new OmpAgentDriver(client)
    const controller = new AbortController()
    const consume = (async () => {
      for await (const _chunk of driver.stream(request([user('u1', 'hello')]), controller.signal)) { /* drain */ }
    })()
    await tick()
    client.settle()

    driver.markUserCancel()
    controller.abort({ kind: 'user' })
    await consume

    expect(client.commands.filter(command => command.type === 'abort')).toEqual([{ type: 'abort' }])
  })

  it('never aborts the live OMP run after the attachment starts detaching', async () => {
    const client = new FakeClient()
    const driver = new OmpAgentDriver(client)
    const controller = new AbortController()
    const consume = (async () => {
      for await (const _chunk of driver.stream(request([user('u1', 'hello')]), controller.signal)) { /* drain */ }
    })()
    await tick()
    client.settle()

    driver.close()
    driver.markUserCancel()
    controller.abort({ kind: 'user' })
    await consume

    expect(client.commands.filter(command => command.type === 'abort')).toEqual([])
  })

  it('never re-steers an external TUI message on a later turn', async () => {
    const client = new FakeClient()
    const driver = new OmpAgentDriver(client)
    const typed = 'typed in the terminal'
    const claimController = new AbortController()

    client.emit({ type: 'agent_start' })
    client.emit({ type: 'message_end', messageId: 'tui-1', message: { role: 'user', content: [{ type: 'text', text: typed }] } })

    const claimed = (async () => {
      for await (const _chunk of driver.stream(request([user('tui-copy', typed)]), claimController.signal)) { /* drain */ }
    })()
    await tick()
    expect(client.commands).toEqual([])
    claimController.abort()
    await claimed

    const next = (async () => {
      for await (const _chunk of driver.stream(request([
        user('tui-copy', typed),
        user('u2', 'next'),
      ]), new AbortController().signal)) { /* drain */ }
    })()
    await tick()
    expect(client.promptText(0)).toBe('next')
    client.settle()
    settlePrompt(client)
    await next
    driver.close()
  })

  it('claims an external message whose delivered copy differs only in whitespace', async () => {
    const client = new FakeClient()
    const driver = new OmpAgentDriver(client)
    const typed = 'typed   in the terminal'
    const controller = new AbortController()

    client.emit({ type: 'agent_start' })
    client.emit({ type: 'message_end', messageId: 'tui-2', message: { role: 'user', content: [{ type: 'text', text: typed }] } })

    const consume = (async () => {
      for await (const _chunk of driver.stream(request([user('tui-copy', 'typed in the terminal')]), controller.signal)) { /* drain */ }
    })()
    await tick()
    expect(client.commands).toEqual([])
    controller.abort()
    await consume
    driver.close()
  })

  it('claims a custom message so its harness copy is never steered back', async () => {
    const client = new FakeClient()
    const driver = new OmpAgentDriver(client)
    const mail = '<hcom from="lead">ship it</hcom>'
    const controller = new AbortController()

    client.emit({ type: 'agent_start' })
    client.emit({ type: 'message_end', messageId: 'custom-1', message: { role: 'custom', content: [{ type: 'text', text: mail }] } })

    const consume = (async () => {
      for await (const _chunk of driver.stream(request([user('mail-copy', mail)]), controller.signal)) { /* drain */ }
    })()
    await tick()
    expect(client.commands).toEqual([])
    controller.abort()
    await consume
    driver.close()
  })
})

describe('OmpAgentDriver unsolicited wakes', () => {
  it('opens a live turn and classifies a background system notice', () => {
    const client = new FakeClient()
    const wakes: unknown[] = []
    const driver = new OmpAgentDriver(client, { onUnsolicitedWake: (wake) => { wakes.push(wake) } })
    const notice = '<system-notice>\nBackground job abc has completed. Resume your work.\n</system-notice>'

    client.emit({ type: 'agent_start' })
    client.emit({ type: 'message_start', message: { role: 'user' } })
    client.emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: notice }] } })

    expect(wakes).toEqual([{
      text: notice,
      source: {
        kind: 'omp-subagent-settled',
        form: 'notice',
        summary: 'Background job abc has completed. Resume your work.',
      },
    }])
    driver.close()
  })

  it('classifies hcom actor mail as an agent message relay', () => {
    const client = new FakeClient()
    const wakes: unknown[] = []
    const driver = new OmpAgentDriver(client, { onUnsolicitedWake: (wake) => { wakes.push(wake) } })
    const mail = '<hcom from="lead">ship it</hcom>'

    client.emit({ type: 'agent_start' })
    client.emit({ type: 'message_end', message: { role: 'custom', content: mail } })

    expect(wakes).toEqual([{
      text: mail,
      source: { kind: 'omp-agent-message', form: 'relay' },
    }])
    driver.close()
  })

  it('attributes an assistant reply with no waking message to a generic background wake', () => {
    const client = new FakeClient()
    const wakes: unknown[] = []
    const driver = new OmpAgentDriver(client, { onUnsolicitedWake: (wake) => { wakes.push(wake) } })

    client.emit({ type: 'agent_start' })
    client.emit({ type: 'message_start', message: { role: 'assistant' } })

    expect(wakes).toEqual([{
      text: 'Background agent wake',
      source: { kind: 'omp-wake', form: 'notice', summary: 'Background agent wake' },
    }])
    driver.close()
  })

  it('never treats the prompt it sent as an unsolicited wake', async () => {
    const client = new FakeClient()
    const wakes: unknown[] = []
    const driver = new OmpAgentDriver(client, { onUnsolicitedWake: (wake) => { wakes.push(wake) } })
    const consume = (async () => {
      for await (const _chunk of driver.stream(request([user('u1', 'hello')]), new AbortController().signal)) { /* drain */ }
    })()
    await tick()

    client.emit({ type: 'agent_start' })
    client.settle()
    client.emit(messageUpdate('m1', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('m1', { type: 'text_end', contentIndex: 0, content: 'ok' }, assistantMessage('ok', 'stop', { input: 1, output: 1 })))
    settlePrompt(client)
    await consume

    expect(wakes).toEqual([])
    expect(client.commands.map(command => command.type)).toEqual(['prompt'])
  })

  it('consumes the buffered wake run without prompting or steering again', async () => {
    const client = new FakeClient()
    const wakes: unknown[] = []
    const driver = new OmpAgentDriver(client, { onUnsolicitedWake: (wake) => { wakes.push(wake) } })
    const mail = '<hcom from="lead">ship it</hcom>'

    client.emit({ type: 'agent_start' })
    client.emit({ type: 'message_start', message: { role: 'user' } })
    client.emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: mail }] } })
    client.emit(messageUpdate('w1', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('w1', { type: 'text_delta', contentIndex: 0, delta: 'ack' }, assistantMessage('ack', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('w1', { type: 'text_end', contentIndex: 0, content: 'ack' }, assistantMessage('ack', 'stop', { input: 1, output: 1 })))
    client.emit({ type: 'agent_end', isTerminal: true })

    const chunks: StreamChunk[] = []
    for await (const chunk of driver.stream(request([]), new AbortController().signal)) chunks.push(chunk)

    expect(wakes).toEqual([{ text: mail, source: { kind: 'omp-agent-message', form: 'relay' } }])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'ack' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'ack' } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(client.commands).toEqual([])
    driver.close()
  })

  it('adopts a run already streaming when the driver attaches mid-turn', async () => {
    const client = new FakeClient()
    const wakes: unknown[] = []
    const driver = new OmpAgentDriver(client, {
      streaming: true,
      onUnsolicitedWake: (wake) => { wakes.push(wake) },
    })

    client.emit(messageUpdate('w1', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('w1', { type: 'text_delta', contentIndex: 0, delta: 'still' }, assistantMessage('still', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('w1', { type: 'text_end', contentIndex: 0, content: 'still' }, assistantMessage('still', 'stop', { input: 1, output: 1 })))
    client.emit({ type: 'agent_end', isTerminal: true })

    const chunks: StreamChunk[] = []
    for await (const chunk of driver.stream(request([]), new AbortController().signal)) chunks.push(chunk)

    expect(wakes).toEqual([{
      text: 'Background agent wake',
      source: { kind: 'omp-wake', form: 'notice', summary: 'Background agent wake' },
    }])
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: 'still' }])
    expect(client.commands).toEqual([])
    driver.close()
  })

  it('opens an unsolicited prompt from a user frame after a missed agent_start', async () => {
    const client = new FakeClient()
    const wakes: unknown[] = []
    const driver = new OmpAgentDriver(client, { onUnsolicitedWake: (wake) => { wakes.push(wake) } })
    const typed = 'stream without agent_start'

    client.emit({ type: 'message_start', message: { role: 'user' } })
    client.emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: typed }] } })
    client.emit(messageUpdate('w2', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('w2', { type: 'text_delta', contentIndex: 0, delta: 'late' }, assistantMessage('late', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('w2', { type: 'text_end', contentIndex: 0, content: 'late' }, assistantMessage('late', 'stop', { input: 1, output: 1 })))
    client.emit({ type: 'agent_end', isTerminal: true })

    const chunks: StreamChunk[] = []
    for await (const chunk of driver.stream(request([]), new AbortController().signal)) chunks.push(chunk)

    expect(wakes).toEqual([{ text: typed }])
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: 'late' }])
    expect(client.commands).toEqual([])
    driver.close()
  })

  it('never fabricates a wake from assistant output or a tool execution alone', () => {
    const client = new FakeClient()
    const wakes: unknown[] = []
    const driver = new OmpAgentDriver(client, { onUnsolicitedWake: (wake) => { wakes.push(wake) } })

    client.emit({ type: 'tool_execution_start', toolCallId: 't-1', toolName: 'bash', args: { command: 'sleep 1' } })
    client.emit({ type: 'message_start', message: { role: 'assistant' } })
    client.emit(messageUpdate('m1', { type: 'text_delta', contentIndex: 0, delta: 'late' }, assistantMessage('late', 'stop', { input: 1, output: 1 })))
    client.emit({ type: 'agent_end', isTerminal: true })

    expect(wakes).toEqual([])
    expect(driver.hasActiveRun()).toBe(false)
    driver.close()
  })

  it('abandons a settled prompt so the next run wakes the harness with its own input', () => {
    const client = new FakeClient()
    const wakes: unknown[] = []
    const driver = new OmpAgentDriver(client, { onUnsolicitedWake: (wake) => { wakes.push(wake) } })
    const first = 'first terminal prompt'
    const second = 'second terminal prompt'

    client.emit({ type: 'agent_start' })
    client.emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: first }] } })
    client.emit(messageUpdate('w1', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('w1', { type: 'text_end', contentIndex: 0, content: 'done' }, assistantMessage('done', 'stop', { input: 1, output: 1 })))
    client.emit({ type: 'agent_end', isTerminal: true })
    client.emit({ type: 'agent_start' })
    client.emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: second }] } })

    expect(wakes).toEqual([{ text: first }, { text: second }])
    expect(driver.hasActiveRun()).toBe(true)
    driver.close()
  })

  it('wakes from a TUI prompt that carries only an image', () => {
    const client = new FakeClient()
    const wakes: unknown[] = []
    const driver = new OmpAgentDriver(client, { onUnsolicitedWake: (wake) => { wakes.push(wake) } })

    client.emit({ type: 'agent_start' })
    client.emit({
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
    })

    expect(wakes).toEqual([{ text: '[image]' }])
    driver.close()
  })

  it('prompts instead of steering when the previous unsolicited run already settled', async () => {
    const client = new FakeClient()
    const driver = new OmpAgentDriver(client)
    const mail = '<hcom from="lead">ship it</hcom>'

    client.emit({ type: 'agent_start' })
    client.emit({ type: 'message_end', message: { role: 'custom', content: mail } })
    client.emit(messageUpdate('w1', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('w1', { type: 'text_end', contentIndex: 0, content: 'ack' }, assistantMessage('ack', 'stop', { input: 1, output: 1 })))
    client.emit({ type: 'agent_end', isTerminal: true })

    const chunks: StreamChunk[] = []
    const consuming = (async () => {
      for await (const chunk of driver.stream(request([user('u1', 'next')]), new AbortController().signal)) chunks.push(chunk)
    })()
    await tick()

    expect(client.commands.map(command => command.type)).toEqual(['prompt'])
    client.settle()
    client.emit(messageUpdate('m2', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('m2', { type: 'text_delta', contentIndex: 0, delta: 'fresh' }, assistantMessage('fresh', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('m2', { type: 'text_end', contentIndex: 0, content: 'fresh' }, assistantMessage('fresh', 'stop', { input: 1, output: 1 })))
    settlePrompt(client)
    await consuming

    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: 'fresh' }])
    driver.close()
  })

  it('keeps a TUI-typed prompt out of the outbound prompt and steer path', async () => {
    const client = new FakeClient()
    const wakes: unknown[] = []
    const driver = new OmpAgentDriver(client, { onUnsolicitedWake: (wake) => { wakes.push(wake) } })
    const typed = 'refactor the sidebar'

    client.emit({ type: 'agent_start' })
    client.emit({ type: 'message_start', message: { role: 'user' } })
    client.emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: typed }] } })
    client.emit(messageUpdate('w3', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('w3', { type: 'text_delta', contentIndex: 0, delta: 'on it' }, assistantMessage('on it', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('w3', { type: 'text_end', contentIndex: 0, content: 'on it' }, assistantMessage('on it', 'stop', { input: 1, output: 1 })))
    client.emit({ type: 'agent_end', isTerminal: true })

    const chunks: StreamChunk[] = []
    for await (const chunk of driver.stream(request([user('u1', typed)]), new AbortController().signal)) chunks.push(chunk)

    expect(wakes).toStrictEqual([{ text: typed }])
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: 'on it' }])
    expect(client.commands).toEqual([])
    driver.close()
  })

  it('publishes a terminal prompt before agent_start, once per message id', () => {
    const client = new FakeClient()
    const wakes: unknown[] = []
    const driver = new OmpAgentDriver(client, { onUnsolicitedWake: (wake) => { wakes.push(wake) } })
    const typed = 'typed while the session was idle'

    client.emit({ type: 'message_start', messageId: 'user-1', message: { role: 'user' } })
    expect(wakes).toEqual([])
    client.emit({
      type: 'message_end', messageId: 'user-1', message: { role: 'user', content: [{ type: 'text', text: typed }] },
    })
    expect(wakes).toEqual([{ text: typed }])

    client.emit({ type: 'agent_start' })
    client.emit({
      type: 'message_end', messageId: 'user-1', message: { role: 'user', content: [{ type: 'text', text: typed }] },
    })
    expect(wakes).toEqual([{ text: typed }])
    driver.close()
  })

  it('publishes every terminal steer inside one running turn', () => {
    const client = new FakeClient()
    const wakes: unknown[] = []
    const driver = new OmpAgentDriver(client, { onUnsolicitedWake: (wake) => { wakes.push(wake) } })

    client.emit({ type: 'agent_start' })
    client.emit({
      type: 'message_end', messageId: 's-1', message: { role: 'user', content: [{ type: 'text', text: 'first' }] },
    })
    client.emit({ type: 'tool_execution_start', toolCallId: 't-1', toolName: 'bash', args: { command: 'sleep 5' } })
    client.emit({
      type: 'message_end', messageId: 's-2', message: { role: 'user', content: [{ type: 'text', text: 'second' }] },
    })

    expect(wakes).toEqual([{ text: 'first' }, { text: 'second' }])
    driver.close()
  })

  it('stays silent for the echo of a steer the driver sent itself', async () => {
    const client = new FakeClient()
    const wakes: unknown[] = []
    const driver = new OmpAgentDriver(client, { onUnsolicitedWake: (wake) => { wakes.push(wake) } })

    client.emit({ type: 'agent_start' })
    client.emit({
      type: 'message_end', messageId: 's-1', message: { role: 'user', content: [{ type: 'text', text: 'typed' }] },
    })
    const steering = driver.steerImmediate([user('u2', 'from the web')])
    await tick()
    client.settle()
    await steering
    client.emit({
      type: 'message_end', messageId: 's-2', message: { role: 'user', content: [{ type: 'text', text: 'from the web' }] },
    })

    expect(wakes).toEqual([{ text: 'typed' }])
    driver.close()
  })

  it('settles a steer-interrupted cycle as a stop so the turn stays green', async () => {
    const client = new FakeClient()
    const driver = new OmpAgentDriver(client)
    const consume = (async () => {
      const chunks: StreamChunk[] = []
      for await (const chunk of driver.stream(request([user('u1', 'hello')]), new AbortController().signal)) chunks.push(chunk)
      return chunks
    })()
    await tick()
    client.settle()
    const aborted = assistantMessage('half', 'aborted', { input: 1, output: 1 })
    client.emit(messageUpdate('m1', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'aborted', { input: 1, output: 1 })))
    client.emit(messageUpdate('m1', { type: 'text_delta', contentIndex: 0, delta: 'half' }, aborted))
    client.emit({ type: 'message_end', messageId: 'm1', message: aborted })
    client.emit({ type: 'message_start', messageId: 'm2', message: { role: 'assistant' } })
    const chunks = await consume
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('does not fail a prompt aborted after a terminal steer', async () => {
    const client = new FakeClient()
    const wakes: unknown[] = []
    const driver = new OmpAgentDriver(client, { onUnsolicitedWake: (wake) => { wakes.push(wake) } })
    const consume = (async () => {
      const chunks: StreamChunk[] = []
      for await (const chunk of driver.stream(request([user('u1', 'hello')]), new AbortController().signal)) chunks.push(chunk)
      return chunks
    })()
    await tick()
    client.settle()
    const aborted = assistantMessage('half', 'aborted', { input: 1, output: 1 })
    client.emit(messageUpdate('m1', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'aborted', { input: 1, output: 1 })))
    client.emit(messageUpdate('m1', { type: 'text_delta', contentIndex: 0, delta: 'half' }, aborted))
    client.emit({
      type: 'message_end', messageId: 't-1', message: { role: 'user', content: [{ type: 'text', text: 'steer from terminal' }] },
    })
    client.emit({ type: 'message_end', messageId: 'm1', message: aborted })
    settlePrompt(client, 'aborted')
    const chunks = await consume

    expect(wakes).toEqual([{ text: 'steer from terminal' }])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('ignores OMP-injected memory and reminder frames', () => {
    const client = new FakeClient()
    const wakes: unknown[] = []
    const driver = new OmpAgentDriver(client, { onUnsolicitedWake: (wake) => { wakes.push(wake) } })

    client.emit({ type: 'agent_start' })
    client.emit({
      type: 'message_end', messageId: 'mem-1', message: { role: 'user', content: [{ type: 'text', text: '<memories>\nrecall\n</memories>' }] },
    })
    client.emit({
      type: 'message_end', messageId: 'rem-1', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>\nrule\n</system-reminder>' }] },
    })

    expect(wakes).toEqual([])
    driver.close()
  })

  it('strips the interjection notice and claims both copies', async () => {
    const client = new FakeClient()
    const wakes: unknown[] = []
    const driver = new OmpAgentDriver(client, { onUnsolicitedWake: (wake) => { wakes.push(wake) } })
    const raw = '<system-notice>\nUser interjection during work: priority; supersedes conflicting prior instructions. Re-read; ensure current work reflects user intent.\n</system-notice>\nstop the sidebar refactor'
    const display = 'stop the sidebar refactor'

    client.emit({ type: 'agent_start' })
    client.emit({
      type: 'message_end', messageId: 'i-1', message: { role: 'user', content: [{ type: 'text', text: raw }] },
    })
    expect(wakes).toEqual([{ text: display }])

    const first = new AbortController()
    const consuming = (async () => {
      for await (const _chunk of driver.stream(request([user('i-copy', display)]), first.signal)) { /* drain */ }
    })()
    await tick()
    expect(client.commands).toEqual([])
    first.abort()
    await consuming

    for await (const _chunk of driver.stream(request([user('i-copy', display), user('raw-copy', raw)]), new AbortController().signal)) { /* drain */ }
    expect(client.commands).toEqual([])
    driver.close()
  })
})
