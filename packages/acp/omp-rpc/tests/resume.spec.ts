import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import {
  hydrateOmpSession,
  ompHydrationEvents,
  readOmpTranscriptTitle,
} from '../src/resume.ts'

const roots: string[] = []

async function transcript(lines: readonly unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omp-hydrate-'))
  roots.push(root)
  const path = join(root, '2026-11-03T00-00-00-000Z_01a0c88e-7521-7000-bb6a-67527d2b6806.jsonl')
  await writeFile(path, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('readOmpTranscriptTitle', () => {
  it('reads the newest title across title and title_change records', async () => {
    const path = await transcript([
      { type: 'title', v: 1, title: 'Newest  title', updatedAt: '2026-11-03T09:09:55.942Z' },
      { type: 'session', version: 3, id: '01a0c88e-7521-7000-bb6a-67527d2b6806', title: 'Header title' },
      { type: 'title_change', title: 'Older title', timestamp: '2026-11-02T08:33:11.974Z' },
    ])
    expect(await readOmpTranscriptTitle(path)).toBe('Newest title')
  })

  it('ignores an empty title record', async () => {
    const path = await transcript([
      { type: 'title', v: 1, title: '', updatedAt: '2026-11-03T09:09:55.942Z' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    ])
    expect(await readOmpTranscriptTitle(path)).toBeUndefined()
  })
})

describe('ompHydrationEvents', () => {
  it('rebuilds visible turn, step, user, assistant, and tool events from a real transcript', async () => {
    const path = await transcript([
      { type: 'title', v: 1, title: 'Original' },
      { type: 'session', version: 3, id: '01a0c88e-7521-7000-bb6a-67527d2b6806', cwd: '/home' },
      {
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'inspect the runtime' }],
        },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          provider: 'cpa',
          model: 'grok-4.7',
          content: [
            { type: 'thinking', thinking: 'read first' },
            { type: 'text', text: 'reading now' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/tmp/a' }, intent: 'Reading the file' },
          ],
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'file body' }],
        },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
      },
    ])

    const events = await ompHydrationEvents(path)

    expect(events.map(event => event.type)).toEqual([
      'turn/start',
      'step/start',
      'user/message',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'step/start',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    expect(events[0]?.data).toEqual({ turn: 1 })
    expect(events[1]?.data).toEqual({ turn: 1, step: 1 })
    expect(events[2]?.data).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'inspect the runtime' }],
    })
    expect(events[3]?.data).toMatchObject({
      turn: 1,
      step: 1,
      stream: [],
      message: {
        role: 'assistant',
        source: { kind: 'model', provider: 'cpa', model: 'grok-4.7' },
        content: [
          { type: 'reasoning', text: 'read first' },
          { type: 'text', text: 'reading now' },
          { type: 'tool-call', name: 'read', arguments: '{"i":"Reading the file","path":"/tmp/a"}' },
        ],
      },
    })
    expect(events[4]?.data).toMatchObject({
      turn: 1,
      step: 1,
      callId: 'call-1',
      name: 'read',
      arguments: '{"i":"Reading the file","path":"/tmp/a"}',
    })
    expect(events[5]?.data).toMatchObject({
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool' },
        content: [{ type: 'text', text: 'file body' }],
        isError: false,
      },
    })
    expect(events[8]?.data).toMatchObject({ turn: 1, step: 2 })
    expect(events[10]?.data).toEqual({ turn: 1, reason: { kind: 'completed' } })
  })

  it('takes intent and arguments from recorded tool execution starts', async () => {
    const path = await transcript([
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'inspect' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-9', name: 'read' }],
        },
      },
      {
        type: 'custom',
        customType: 'tool_execution_start',
        data: { toolCallId: 'call-9', toolName: 'read', args: { path: '/tmp/z' }, intent: 'Reading zed' },
      },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'call-9', content: [{ type: 'text', text: 'zed' }] } },
    ])

    const events = await ompHydrationEvents(path)
    const call = events.find(event => event.type === 'tool/call')

    expect(call?.data).toMatchObject({
      callId: 'call-9',
      name: 'read',
      arguments: '{"i":"Reading zed","path":"/tmp/z"}',
    })
  })

  it('starts a new turn at each user message and drops empty messages', async () => {
    const path = await transcript([
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'one' }] } },
      { type: 'message', message: { role: 'assistant', content: [] } },
      { type: 'message', message: { role: 'user', content: [{ type: 'image', mimeType: 'image/png' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] } },
    ])

    const events = await ompHydrationEvents(path)

    expect(events.map(event => event.type)).toEqual([
      'turn/start',
      'step/start',
      'user/message',
      'step/end',
      'turn/end',
      'turn/start',
      'step/start',
      'user/message',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    expect(events[7]?.data).toMatchObject({ content: [{ type: 'text', text: '[image]' }] })
    expect(events[8]?.data).toMatchObject({ turn: 2, step: 1 })
    expect(events[4]?.data).toEqual({ turn: 1, reason: { kind: 'completed' } })
    expect(events[10]?.data).toEqual({ turn: 2, reason: { kind: 'completed' } })
  })

  it('always keeps the newest turn intact when the limit is small', async () => {
    const path = await transcript([
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'second' }] } },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'third' }] } },
    ])

    const events = await ompHydrationEvents(path, 2)

    expect(events.map(event => event.type)).toEqual([
      'turn/start',
      'step/start',
      'user/message',
      'step/end',
      'turn/end',
    ])
    expect(events[0]?.data).toEqual({ turn: 1 })
    expect(events[2]?.data).toMatchObject({ content: [{ type: 'text', text: 'third' }] })
  })

  it('renumbers retained turns from one after the limit drops earlier turns', async () => {
    const path = await transcript([
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'one' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'first reply' }] } },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'two' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'second reply' }] } },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'three' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'third reply' }] } },
    ])

    const events = await ompHydrationEvents(path, 12)

    expect(events.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1, 2])
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data.turn)).toEqual([1, 2])
    expect(events
      .filter(event => event.type === 'assistant/message')
      .map(event => event.data.turn)).toEqual([1, 2])
    expect(events
      .filter(event => event.type === 'step/start')
      .map(event => event.data.turn)).toEqual([1, 2])

    const session = Session.create(SessionId('hydrated-renumber'))
    await hydrateOmpSession(session, path, 12)
    const root = await mkdtemp(join(tmpdir(), 'dsh-hydrate-log-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const handle = await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id: session.id,
      createdAt: 1,
      cwd: '/work',
      isSeeded: false,
    })
    try {
      await handle.append(session.snapshotEvents())
    } finally {
      await handle.close()
    }
    const reopened = await ctx.sessionPersistence.open(session.id, 'read')
    try {
      const stored = await reopened.read()
      expect(stored.events.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1, 2])
    } finally {
      await reopened.close()
    }
  })
  it('advertises each surviving tool call and drops orphan calls before the next message', async () => {
    const path = await transcript([
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'one' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'checking' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/tmp/a' } },
            { type: 'toolCall', id: 'call-orphan', name: 'bash', arguments: { command: 'true' } },
          ],
        },
      },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'call-1', isError: true, content: [{ type: 'text', text: 'boom' }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'call-never', content: [{ type: 'text', text: 'ignored' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'two' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'toolCall', id: 'call-2', name: 'grep', arguments: '{"pattern":"x"}' },
          ],
        },
      },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'call-2', isError: true, content: [{ type: 'text', text: 'nope' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'finished' }] } },
    ])

    const events = await ompHydrationEvents(path)

    expect(events.map(event => event.type)).toEqual([
      'turn/start',
      'step/start',
      'user/message',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'step/start',
      'assistant/message',
      'step/end',
      'turn/end',
      'turn/start',
      'step/start',
      'user/message',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'step/start',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    expect(events
      .filter(event => event.type === 'tool/call')
      .map(event => event.data)).toEqual([
      { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"path":"/tmp/a"}' },
      { turn: 2, step: 1, callId: 'call-2', name: 'grep', arguments: '{"pattern":"x"}' },
    ])
    expect(events
      .filter(event => event.type === 'tool/result')
      .map(event => event.data.message.toolCallId)).toEqual(['call-1', 'call-2'])
    expect(events[3]?.data).toMatchObject({
      message: {
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool-call', id: 'call-1', name: 'read' },
        ],
      },
    })
  })

  it('round-trips hydrated tool calls through a persisted zstd session log after slicing turns', async () => {
    const path = await transcript([
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'one' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'checking' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/tmp/a' } },
          ],
        },
      },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'call-1', isError: true, content: [{ type: 'text', text: 'boom' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'two' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'toolCall', id: 'call-2', name: 'grep', arguments: '{"pattern":"x"}' },
          ],
        },
      },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'call-2', isError: true, content: [{ type: 'text', text: 'nope' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'finished' }] } },
    ])
    const session = Session.create(SessionId('hydrated-tool-calls'))
    await hydrateOmpSession(session, path, 20)

    const root = await mkdtemp(join(tmpdir(), 'dsh-hydrate-log-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    const handle = await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id: session.id,
      createdAt: 1,
      cwd: '/work',
      isSeeded: false,
    })
    try {
      await handle.append(session.snapshotEvents())
    } finally {
      await handle.close()
    }

    const reopened = await ctx.sessionPersistence.open(session.id, 'read')
    try {
      const stored = await reopened.read()
      expect(stored.events.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1])
      expect(stored.events
        .filter(event => event.type === 'tool/call')
        .map(event => ({ turn: event.data.turn, step: event.data.step, callId: event.data.callId })))
        .toEqual([{ turn: 1, step: 1, callId: 'call-2' }])
      expect(stored.events
        .filter(event => event.type === 'tool/result')
        .map(event => event.data.message.isError)).toEqual([true])
    } finally {
      await reopened.close()
    }
  })
})

describe('hydrateOmpSession', () => {
  it('appends the recorded title before structural events', async () => {
    const path = await transcript([
      { type: 'title', v: 1, title: 'Resume and search OMP history', updatedAt: '2026-11-03T09:09:55.942Z' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    ])
    const session = Session.create(SessionId('hydrated-title'))

    const appended = await hydrateOmpSession(session, path)
    const events = session.snapshotEvents()

    expect(appended).toBe(events.length)
    expect(events[0]).toMatchObject({
      type: 'session/title',
      data: { title: 'Resume and search OMP history', messageSeqs: [], source: { kind: 'user' } },
    })
    expect(events.map(event => event.type)).toEqual([
      'session/title',
      'turn/start',
      'step/start',
      'user/message',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
  })
})

describe('ompHydrationEvents trigger cards', () => {
  it('classifies background notices and hcom mail as native trigger cards', async () => {
    const path = await transcript([
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: '<system-notice>\nBackground job abc has completed. Resume your work.\n</system-notice>' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'resumed' }] } },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: '<hcom from="lead">ship it</hcom>' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'shipping' }] } },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'plain question' }] } },
    ])

    const users = (await ompHydrationEvents(path)).filter(event => event.type === 'user/message')

    expect(users.map(event => event.data.source)).toEqual([
      { kind: 'subagent-settled', form: 'notice', summary: 'Background job abc has completed. Resume your work.' },
      { kind: 'agent-message', form: 'relay' },
      { kind: 'user' },
    ])
  })
})
