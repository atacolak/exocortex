import { existsSync } from 'node:fs'
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  type SessionAppendTiming,
  type SessionEvent,
  type SurfaceIntent,
} from '@deepseek-ai/dsh-session'
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
  type ContentBlock,
} from '@deepseek-ai/dsh-llm'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import {
  appendOmpCompactionBoundary,
  hydrateOmpSession,
  ompHydrationEvents,
  ompTranscriptTurns,
  readOmpTranscriptTitle,
  type OmpHydrationCursor,
  type OmpHydrationOutcome,
  type OmpTranscriptTurn,
} from '../src/resume.ts'

const roots: string[] = []

const SESSION_UUID = '01a0c88e-7521-7000-bb6a-67527d2b6806'

const REAL_TRANSCRIPT = join(homedir(), '.omp', 'agent', 'sessions', '-workspace',
  '2026-10-25T08-26-39-017Z_01a1722b-3e29-7000-b9d5-b05807bbe4b8.jsonl')

function firstText(blocks: readonly { readonly type: string; readonly text?: string }[]): string | undefined {
  const block = blocks[0]
  return block?.type === 'text' ? block.text : undefined
}

function entryId(n: number): string {
  return n.toString(16).padStart(8, '0')
}

function sessionLine(): Record<string, unknown> {
  return { type: 'session', version: 3, id: SESSION_UUID, cwd: '/work' }
}

function userEntry(id: string, parent: string, text: string): Record<string, unknown> {
  return { type: 'message', id, parentId: parent, message: { role: 'user', content: [{ type: 'text', text }] } }
}

function assistantEntry(id: string, parent: string, text: string): Record<string, unknown> {
  return { type: 'message', id, parentId: parent, message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

function turnEntries(from: number, to: number): unknown[] {
  const lines: unknown[] = []
  for (let turn = from; turn <= to; turn += 1) {
    const parent = turn === 1 ? SESSION_UUID : entryId(turn * 2 - 2)
    lines.push(userEntry(entryId(turn * 2 - 1), parent, `turn ${String(turn)}`))
    lines.push(assistantEntry(entryId(turn * 2), entryId(turn * 2 - 1), `reply ${String(turn)}`))
  }
  return lines
}

function turnUserTexts(turns: readonly OmpTranscriptTurn[]): (string | undefined)[] {
  return turns.map(turn => turn.events
    .filter(event => event.type === 'user/message')
    .map(event => firstText(event.data.content))
    .at(0))
}

function isSessionUserMessage(event: SessionEvent): event is SessionEvent<'user/message'> {
  return event.type === 'user/message' && !isCompactCheckpointSource(event.data.source)
}

function sessionUserTexts(session: Session): (string | undefined)[] {
  return session.snapshotEvents()
    .filter(isSessionUserMessage)
    .map(event => firstText(event.data.content))
}

function sessionUserTimes(session: Session): number[] {
  return session.snapshotEvents()
    .filter(isSessionUserMessage)
    .map(event => event.time)
}

function sessionTurnOpeningMessages(events: readonly SessionEvent[]): SessionEvent<'user/message'>[] {
  const openings: SessionEvent<'user/message'>[] = []
  let awaiting = true
  for (const event of events) {
    if (event.type === 'turn/start') {
      awaiting = true
      continue
    }
    if (!awaiting || !isSessionUserMessage(event)) continue
    openings.push(event)
    awaiting = false
  }
  return openings
}

function sessionTurnNumbers(session: Session): number[] {
  return session.snapshotEvents()
    .filter(event => event.type === 'turn/start')
    .map(event => event.data.turn)
}

function cursorOf(outcome: OmpHydrationOutcome): OmpHydrationCursor {
  return {
    hydratedTurns: outcome.hydratedTurns,
    ...outcome.hydratedLeafEntryId === undefined ? {} : { hydratedLeafEntryId: outcome.hydratedLeafEntryId },
    ...outcome.hydratedByteOffset === undefined ? {} : { hydratedByteOffset: outcome.hydratedByteOffset },
  }
}

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

    const outcome = await hydrateOmpSession(session, path)
    const events = session.snapshotEvents()

    expect(outcome.appended).toBe(events.length)
    expect(outcome.turns).toBe(1)
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

describe('hydrateOmpSession tail sync', () => {
  const userLine = (text: string): unknown => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } })
  const assistantLine = (text: string): unknown => ({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } })

  it('appends only the turns the transcript gained and renumbers them after the session', async () => {
    const path = await transcript([
      { type: 'title', v: 1, title: 'Yesterday', updatedAt: '2026-11-03T09:00:00.000Z' },
      userLine('one'),
      assistantLine('one reply'),
      userLine('two'),
      assistantLine('two reply'),
    ])
    const session = Session.create(SessionId('tail-sync'))
    const first = await hydrateOmpSession(session, path)
    expect(first.turns).toBe(2)

    await appendFile(path, [
      { type: 'title_change', title: 'Integrate OMP steer handling', timestamp: '2026-11-04T09:00:00.000Z' },
      userLine('three'),
      assistantLine('three reply'),
      userLine('four'),
      assistantLine('four reply'),
      userLine('five'),
      assistantLine('five reply'),
    ].map(line => JSON.stringify(line)).join('\n') + '\n')

    const second = await hydrateOmpSession(session, path)
    const events = session.snapshotEvents()

    expect(second.turns).toBe(5)
    expect(second.appended).toBeGreaterThan(0)
    expect(events.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1, 2, 3, 4, 5])
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data.turn)).toEqual([1, 2, 3, 4, 5])
    expect(events.filter(event => event.type === 'user/message').map(event => firstText(event.data.content))).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five',
    ])
    expect(events.filter(event => event.type === 'assistant/message').map(event => firstText(event.data.message.content))).toEqual([
      'one reply',
      'two reply',
      'three reply',
      'four reply',
      'five reply',
    ])
    expect(events.filter(event => event.type === 'session/title').map(event => event.data.title)).toEqual([
      'Yesterday',
      'Integrate OMP steer handling',
    ])
  })

  it('appends nothing when the transcript has not grown past the session', async () => {
    const path = await transcript([userLine('only'), assistantLine('reply')])
    const session = Session.create(SessionId('tail-sync-stable'))
    await hydrateOmpSession(session, path)
    const before = session.snapshotEvents().length

    const again = await hydrateOmpSession(session, path)

    expect(again.appended).toBe(0)
    expect(again.turns).toBe(1)
    expect(session.snapshotEvents().length).toBe(before)
  })

  it('replays every transcript turn when the session log carries none', async () => {
    const path = await transcript([
      userLine('one'),
      assistantLine('one reply'),
      userLine('two'),
      assistantLine('two reply'),
      userLine('three'),
      assistantLine('three reply'),
    ])
    const session = Session.create(SessionId('tail-sync-recorded'))

    const outcome = await hydrateOmpSession(session, path, 200, 2)

    expect(outcome.turns).toBe(3)
    expect(session.snapshotEvents().filter(event => event.type === 'user/message').map(event => firstText(event.data.content)))
      .toEqual(['one', 'two', 'three'])
    expect(session.snapshotEvents().filter(event => event.type === 'turn/start').map(event => event.data.turn))
      .toEqual([1, 2, 3])
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
      { kind: 'omp-subagent-settled', form: 'notice', summary: 'Background job abc has completed. Resume your work.' },
      { kind: 'omp-agent-message', form: 'relay' },
      { kind: 'user' },
    ])
  })

  it('hydrates advisor and custom cards through already-registered wake kinds', async () => {
    const advisory = '<advisory severity="blocker" guidance="weigh, don\'t blindly obey">\nStop before shipping.\n</advisory>'
    const path = await transcript([
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'ship it' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'shipping' }] } },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: advisory }] } },
      { type: 'custom_message', customType: 'advisor', display: true, attribution: 'agent', content: [{ type: 'text', text: advisory }] },
      { type: 'custom_message', customType: 'todo', display: true, attribution: 'agent', content: 'Todo list is stale.' },
    ])

    const users = (await ompHydrationEvents(path)).filter(event => event.type === 'user/message')

    expect(users.map(event => event.data.source)).toEqual([
      { kind: 'user' },
      { kind: 'omp-wake', form: 'notice', summary: 'Stop before shipping.' },
      { kind: 'omp-wake', form: 'notice', summary: 'Stop before shipping.' },
      { kind: 'omp-wake', form: 'notice', summary: 'Todo list is stale.' },
    ])
  })
})

describe('ompTranscriptTurns canonical branch', () => {
  it('walks parentId from the active leaf and ignores an abandoned retry branch', async () => {
    const path = await transcript([
      sessionLine(),
      userEntry(entryId(1), SESSION_UUID, 'one'),
      assistantEntry(entryId(2), entryId(1), 'one reply'),
      userEntry(entryId(3), entryId(2), 'two'),
      assistantEntry(entryId(4), entryId(3), 'two reply'),
      userEntry(entryId(5), entryId(2), 'abandoned retry'),
      assistantEntry(entryId(6), entryId(5), 'abandoned reply'),
      userEntry(entryId(7), entryId(4), 'three'),
      assistantEntry(entryId(8), entryId(7), 'three reply'),
    ])

    const turns = await ompTranscriptTurns(path)

    expect(turns.map(turn => turn.turn)).toEqual([1, 2, 3])
    expect(turnUserTexts(turns)).toEqual(['one', 'two', 'three'])
    expect(turns.map(turn => turn.userEntryId)).toEqual([entryId(1), entryId(3), entryId(7)])
    expect(turns.map(turn => turn.leafEntryId)).toEqual([entryId(2), entryId(4), entryId(8)])
  })

  it('bridges a dangling parentId to the preceding root chain without throwing', async () => {
    const path = await transcript([
      sessionLine(),
      userEntry(entryId(1), SESSION_UUID, 'one'),
      assistantEntry(entryId(2), entryId(1), 'one reply'),
      userEntry(entryId(3), entryId(2), 'abandoned retry'),
      assistantEntry(entryId(4), entryId(3), 'abandoned reply'),
      userEntry(entryId(5), entryId(2), 'two'),
      assistantEntry(entryId(6), entryId(5), 'two reply'),
      userEntry(entryId(7), 'deadbeef', 'three'),
      assistantEntry(entryId(8), entryId(7), 'three reply'),
    ])

    const turns = await ompTranscriptTurns(path)

    expect(turnUserTexts(turns)).toEqual(['one', 'two', 'three'])
    expect(turns.map(turn => turn.leafEntryId)).toEqual([entryId(2), entryId(6), entryId(8)])
  })

  it('walks through compaction and branch summary nodes and keeps pre-compaction turns', async () => {
    const path = await transcript([
      sessionLine(),
      userEntry(entryId(1), SESSION_UUID, 'one'),
      assistantEntry(entryId(2), entryId(1), 'one reply'),
      {
        type: 'compaction',
        id: entryId(3),
        parentId: entryId(2),
        firstKeptEntryId: entryId(1),
        tokensBefore: 10,
        tokensAfter: 4,
        summary: 'summary',
        shortSummary: 'short',
      },
      { type: 'branch_summary', id: entryId(4), parentId: entryId(3), fromId: entryId(2), summary: 'branch' },
      userEntry(entryId(5), entryId(4), 'two'),
      assistantEntry(entryId(6), entryId(5), 'two reply'),
    ])

    const turns = await ompTranscriptTurns(path)

    expect(turnUserTexts(turns)).toEqual(['one', 'two'])
    expect(turns.map(turn => turn.userEntryId)).toEqual([entryId(1), entryId(5)])
    expect(turns.map(turn => turn.leafEntryId)).toEqual([entryId(4), entryId(6)])
  })

  it('drops synthetic continue prompts and memory injections from hydrated turns', async () => {
    const path = await transcript([
      sessionLine(),
      userEntry(entryId(1), SESSION_UUID, 'one'),
      assistantEntry(entryId(2), entryId(1), 'one reply'),
      userEntry(entryId(3), entryId(2), 'omp:continue'),
      assistantEntry(entryId(4), entryId(3), 'continued'),
      userEntry(entryId(5), entryId(4), '<memories>\nRelevant memories'),
      assistantEntry(entryId(6), entryId(5), 'recalled'),
      userEntry(entryId(7), entryId(6), 'two'),
      assistantEntry(entryId(8), entryId(7), 'two reply'),
    ])

    const turns = await ompTranscriptTurns(path)

    expect(turnUserTexts(turns)).toEqual(['one', 'two'])
    expect(turns.map(turn => turn.userEntryId)).toEqual([entryId(1), entryId(7)])
  })

  it('hydrates every active-branch turn by default instead of the newest 200', async () => {
    const path = await transcript([sessionLine(), ...turnEntries(1, 250)])

    const events = await ompHydrationEvents(path)
    const session = Session.create(SessionId('hydrate-all-turns'))
    const outcome = await hydrateOmpSession(session, path)

    expect(events.filter(event => event.type === 'turn/start')).toHaveLength(250)
    expect(outcome.turns).toBe(250)
    expect(outcome.appended).toBe(events.length)
    expect(sessionTurnNumbers(session)).toHaveLength(250)
  })

  it('keeps hydrated timestamps non-decreasing when OMP recorded a backwards clock', async () => {
    const path = await transcript([
      sessionLine(),
      { ...userEntry(entryId(1), SESSION_UUID, 'one'), timestamp: '2026-11-04T10:00:00.000Z' },
      { ...assistantEntry(entryId(2), entryId(1), 'one reply'), timestamp: '2026-11-04T09:00:00.000Z' },
      { ...userEntry(entryId(3), entryId(2), 'two'), timestamp: '2026-11-04T11:00:00.000Z' },
      { ...assistantEntry(entryId(4), entryId(3), 'two reply'), timestamp: '2026-11-04T12:00:00.000Z' },
    ])

    const times = (await ompHydrationEvents(path))
      .flatMap(event => event.time === undefined ? [] : [event.time])

    expect(times).toEqual([...times].sort((left, right) => left - right))
    expect(times[0]).toBe(Date.parse('2026-11-04T10:00:00.000Z'))
    expect(times).toContain(Date.parse('2026-11-04T12:00:00.000Z'))

    const session = Session.create(SessionId('hydrate-backwards-clock'))
    await hydrateOmpSession(session, path)

    expect(sessionUserTimes(session)).toEqual([
      Date.parse('2026-11-04T10:00:00.000Z'),
      Date.parse('2026-11-04T11:00:00.000Z'),
    ])
  })

  it('records an empty assistant error as the turn failure instead of completing the turn', async () => {
    const path = await transcript([
      sessionLine(),
      userEntry(entryId(1), SESSION_UUID, 'switch to deepseek'),
      {
        type: 'message',
        id: entryId(2),
        parentId: entryId(1),
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: '400 Upstream request failed: Model is unavailable',
        },
      },
    ])

    const turns = await ompTranscriptTurns(path)

    expect(turns).toHaveLength(1)
    expect(turns[0]?.events.filter(event => event.type === 'assistant/message')).toEqual([])
    const end = turns[0]?.events.find(event => event.type === 'turn/end')
    expect(end?.data.reason).toEqual({
      kind: 'error',
      error: { message: '400 Upstream request failed: Model is unavailable', code: 'PROVIDER_ERROR' },
    })
  })

  it('keeps the assistant text of an errored message and marks the turn failed', async () => {
    const path = await transcript([
      sessionLine(),
      userEntry(entryId(1), SESSION_UUID, 'switch to deepseek'),
      {
        type: 'message',
        id: entryId(2),
        parentId: entryId(1),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The provider refused the request.' }],
          stopReason: 'error',
          errorMessage: 'Model is unavailable',
        },
      },
    ])

    const session = Session.create(SessionId('hydrate-errored-assistant'))
    await hydrateOmpSession(session, path)
    const events = session.snapshotEvents()

    expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(events.find(event => event.type === 'turn/end')?.data.reason).toEqual({
      kind: 'error',
      error: { message: 'Model is unavailable', code: 'PROVIDER_ERROR' },
    })
  })
})

describe('hydrateOmpSession canonical cursor', () => {
  it('appends nothing when a legacy hydratedTurns count predates the turns the session already holds', async () => {
    const full = await transcript([sessionLine(), ...turnEntries(1, 70)])
    const tail = await transcript([sessionLine(), ...turnEntries(9, 70)])
    const session = Session.create(SessionId('legacy-splice'))
    const seeded = await hydrateOmpSession(session, tail)
    const before = session.snapshotEvents().length
    const textsBefore = sessionUserTexts(session)

    const outcome = await hydrateOmpSession(session, full, Number.POSITIVE_INFINITY, { hydratedTurns: 62 })

    expect(seeded.turns).toBe(62)
    expect(outcome.appended).toBe(0)
    expect(outcome.turns).toBe(62)
    expect(session.snapshotEvents().length).toBe(before)
    expect(sessionUserTexts(session)).toEqual(textsBefore)
    expect(textsBefore[0]).toBe('turn 9')
  })

  it('appends only the turns recorded after the saved cursor leaf', async () => {
    const path = await transcript([sessionLine(), ...turnEntries(1, 3)])
    const session = Session.create(SessionId('cursor-tail'))
    const first = await hydrateOmpSession(session, path)
    expect(first.turns).toBe(3)
    expect(first.hydratedLeafEntryId).toBe(entryId(6))
    expect(first.hydratedByteOffset).toBe((await stat(path)).size)

    await appendFile(path, [
      userEntry(entryId(7), entryId(6), 'turn 4'),
      assistantEntry(entryId(8), entryId(7), 'reply 4'),
    ].map(line => JSON.stringify(line)).join('\n') + '\n')

    const second = await hydrateOmpSession(session, path, Number.POSITIVE_INFINITY, cursorOf(first))

    expect(second.appended).toBeGreaterThan(0)
    expect(second.turns).toBe(4)
    expect(second.hydratedLeafEntryId).toBe(entryId(8))
    expect(second.hydratedByteOffset).toBe((await stat(path)).size)
    expect(sessionUserTexts(session)).toEqual(['turn 1', 'turn 2', 'turn 3', 'turn 4'])
    expect(sessionTurnNumbers(session)).toEqual([1, 2, 3, 4])
  })

  it('returns without re-parsing when the byte offset still matches the file size', async () => {
    const path = await transcript([sessionLine(), ...turnEntries(1, 2)])
    const session = Session.create(SessionId('cursor-fast-path'))
    const first = await hydrateOmpSession(session, path)
    const size = (await stat(path)).size
    const before = session.snapshotEvents().length
    await writeFile(path, 'x'.repeat(size))

    const again = await hydrateOmpSession(session, path, Number.POSITIVE_INFINITY, cursorOf(first))

    expect(again.appended).toBe(0)
    expect(again.turns).toBe(2)
    expect(again.hydratedLeafEntryId).toBe(first.hydratedLeafEntryId)
    expect(again.hydratedByteOffset).toBe(size)
    expect(session.snapshotEvents().length).toBe(before)
  })

  it('follows the active retry branch when tail-syncing offline turns', async () => {
    const path = await transcript([sessionLine(), ...turnEntries(1, 3)])
    const session = Session.create(SessionId('cursor-retry-fork'))
    const first = await hydrateOmpSession(session, path)
    await appendFile(path, [
      userEntry(entryId(7), entryId(4), 'abandoned turn 4'),
      assistantEntry(entryId(8), entryId(7), 'abandoned reply'),
      userEntry(entryId(9), entryId(6), 'turn 4'),
      assistantEntry(entryId(10), entryId(9), 'reply 4'),
    ].map(line => JSON.stringify(line)).join('\n') + '\n')

    const second = await hydrateOmpSession(session, path, Number.POSITIVE_INFINITY, cursorOf(first))

    expect(second.turns).toBe(4)
    expect(second.hydratedLeafEntryId).toBe(entryId(10))
    expect(sessionUserTexts(session)).toEqual(['turn 1', 'turn 2', 'turn 3', 'turn 4'])
    expect(sessionTurnNumbers(session)).toEqual([1, 2, 3, 4])
  })

  it('keeps a new turn whose prompt repeats the last completed turn', async () => {
    const path = await transcript([
      sessionLine(),
      userEntry(entryId(1), SESSION_UUID, 'go'),
      assistantEntry(entryId(2), entryId(1), 'reply 1'),
      userEntry(entryId(3), entryId(2), 'go'),
      assistantEntry(entryId(4), entryId(3), 'reply 2'),
    ])
    const session = boundarySession('repeated-prompt')
    closedTurn(session, 1, 'go')

    const outcome = await hydrateOmpSession(session, path, Number.POSITIVE_INFINITY, {
      hydratedTurns: 1,
      hydratedLeafEntryId: entryId(2),
      hydratedByteOffset: 0,
    })

    expect(outcome.appended).toBeGreaterThan(0)
    expect(sessionUserTexts(session)).toEqual(['go', 'go'])
    expect(sessionTurnNumbers(session)).toEqual([1, 2])
    expect(assistantTexts(session)).toEqual(['reply 1', 'reply 2'])
    await expect(persistAndReopen(session)).resolves.toBeDefined()
  })
})

describe.skipIf(!existsSync(REAL_TRANSCRIPT))('real OMP transcript hydration', () => {
  it('hydrates the whole active branch in canonical order and survives a cold reload', async () => {
    const records = (await readFile(REAL_TRANSCRIPT, 'utf8'))
      .split('\n')
      .filter(line => line.trim().length > 0)
      .flatMap((line): Record<string, unknown>[] => {
        try {
          return [JSON.parse(line) as Record<string, unknown>]
        } catch {
          return []
        }
      })
    const lineById = new Map<string, number>()
    for (const [index, record] of records.entries()) {
      const id = record.id
      if (typeof id === 'string') lineById.set(id, index)
    }
    const orphanLine = records.findIndex(record => typeof record.parentId === 'string' && !lineById.has(record.parentId))
    expect(orphanLine).toBeGreaterThan(0)

    const turns = await ompTranscriptTurns(REAL_TRANSCRIPT)
    const userEntryIds = turns.map(turn => turn.userEntryId)
    const userLines = userEntryIds.map(id => id === undefined ? -1 : lineById.get(id) ?? -1)

    expect(turns.length).toBeGreaterThan(400)
    expect(turns.map(turn => turn.turn)).toEqual(turns.map((_, index) => index + 1))
    expect(new Set(userEntryIds).size).toBe(turns.length)
    expect(new Set(turns.map(turn => turn.leafEntryId)).size).toBe(turns.length)
    expect(userLines[0]).toBeGreaterThan(0)
    expect(userLines[0]).toBeLessThan(orphanLine)
    expect(userLines).toEqual([...userLines].sort((left, right) => left - right))

    const session = Session.create(SessionId('real-transcript'))
    const outcome = await hydrateOmpSession(session, REAL_TRANSCRIPT)
    const openings = sessionTurnOpeningMessages(session.snapshotEvents())
    const wakes = session.snapshotEvents()
      .filter(isSessionUserMessage)
      .filter(event => event.data.source.kind !== 'user')

    expect(outcome.turns).toBe(turns.length)
    expect(openings.map(event => firstText(event.data.content))).toEqual(turnUserTexts(turns))
    expect(wakes.length).toBeGreaterThan(0)

    const recordedUserTimes = turns.map(turn => turn.events.find(event => event.type === 'user/message')?.time)
    expect(recordedUserTimes.every(time => time !== undefined)).toBe(true)
    expect(openings.map(event => event.time)).toEqual(recordedUserTimes)
    const users = openings.map(event => firstText(event.data.content))
    expect(users.filter(text => text?.trimStart().startsWith('omp:continue'))).toEqual([])
    expect(users.filter(text => text?.trimStart().startsWith('<memories>')
      || text?.trimStart().startsWith('<system-reminder>'))).toEqual([])
    const checkpoints = session.snapshotEvents().filter(event => event.type === 'compaction/summary')
    expect(checkpoints.length).toBeGreaterThan(0)
    for (const checkpoint of checkpoints) expect(checkpoint.data.shadowedSeqs.length).toBeGreaterThan(0)

    const root = await mkdtemp(join(tmpdir(), 'dsh-real-hydrate-log-'))
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
      expect(stored.events.filter(event => event.type === 'turn/start')).toHaveLength(turns.length)
      const storedUsers = sessionTurnOpeningMessages(stored.events)
      expect(storedUsers).toHaveLength(turns.length)
      expect(stored.events.filter(event => event.type === 'turn/start').map(event => event.data.turn))
        .toEqual(turns.map(turn => turn.turn))
      expect(storedUsers.map(event => event.time)).toEqual(recordedUserTimes)
      expect(stored.events.filter(event => event.type === 'compaction/summary')).toHaveLength(checkpoints.length)
      const storedTimes = stored.events.map(event => event.time)
      expect(storedTimes).toEqual([...storedTimes].sort((left, right) => left - right))
    } finally {
      await reopened.close()
    }
  }, 120_000)
})

function boundarySession(id: string): Session {
  const header = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1,
    cwd: '/work',
    isSeeded: false,
  } as const
  return Session.create(SessionId(id), [], header)
}

function appendSystemHead(
  session: Session,
  turn: number,
  step: number,
  text: string,
  timing: SurfaceIntent<'system/message'> & SessionAppendTiming = { surfaceOp: 'append' },
): SessionEvent<'system/message'> {
  return session.append('system/message', { turn, step, message: createSystemMessage(text) }, timing)
}

function appendUser(session: Session, text: string): SessionEvent<'user/message'> {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function appendAssistant(
  session: Session,
  turn: number,
  step: number,
  content: readonly ContentBlock[],
): SessionEvent<'assistant/message'> {
  return session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({ content, source: { provider: 'omp', model: 'omp' } }),
    stream: [],
  }, { surfaceOp: 'append' })
}

function closeTurn(session: Session, turn: number, step: number): void {
  session.append('step/end', { turn, step })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function closedTurn(session: Session, turn: number, text: string, head?: string): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  if (head !== undefined) appendSystemHead(session, turn, 1, head)
  appendUser(session, text)
  appendAssistant(session, turn, 1, [{ type: 'text', text: `reply ${String(turn)}` }])
  closeTurn(session, turn, 1)
}

async function persistAndReopen(session: Session): Promise<readonly SessionEvent[]> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-boundary-log-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(JsonlSessionPersistence, { root })
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
    return (await reopened.read()).events
  } finally {
    await reopened.close()
  }
}

function compactionSummaries(session: Session): SessionEvent<'compaction/summary'>[] {
  return session.snapshotEvents().filter((event): event is SessionEvent<'compaction/summary'> => event.type === 'compaction/summary')
}

function boundaryOwners(session: Session): (string | number | null)[][] {
  return session.snapshotEvents()
    .filter(event => event.type === 'compaction/start' || event.type === 'compaction/end')
    .map(event => [event.type, event.data.turn])
}

function assistantTexts(session: Session): (string | undefined)[] {
  return session.snapshotEvents()
    .filter((event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message')
    .map(event => firstText(event.data.message.content))
}

describe('appendOmpCompactionBoundary protected system head', () => {
  it('excludes a leading system/message from the shadowed span so the artifact stays readable', async () => {
    const session = boundarySession('boundary-system-head')
    closedTurn(session, 1, 'one', 'You are Argon.')
    closedTurn(session, 2, 'two')
    const headSeq = session.surface.nodes[0]
    expect(headSeq).toBeDefined()
    expect(session.snapshotEvents()[headSeq!]?.type).toBe('system/message')
    const surface = [...session.surface.nodes]

    const compactionId = appendOmpCompactionBoundary(session, {
      entryId: 'cmp-head',
      summary: 'Earlier conversation summarized',
      tokensBefore: 1234,
    })

    expect(compactionId).toBeDefined()
    const [summary] = compactionSummaries(session)
    expect(summary).toBeDefined()
    const expected = surface.slice(1)
    expect(expected.length).toBeGreaterThan(0)
    expect(summary!.data.shadowedSeqs).toEqual(expected)
    expect(summary!.data.shadowedRange).toEqual({ start: expected[0], end: expected.at(-1) })
    expect(summary!.data.shadowedSeqs).not.toContain(headSeq)
    expect(session.surface.nodes[0]).toBe(headSeq)
    expect(session.snapshotEvents().at(-1)?.type).toBe('compaction/end')

    await expect(persistAndReopen(session)).resolves.toBeDefined()
  })

  it('keeps a protected head that a mid-session system/message replacement established', async () => {
    const session = boundarySession('boundary-protected-head')
    closedTurn(session, 1, 'one', 'You are Argon.')
    const originalHead = session.surface.nodes[0]
    expect(originalHead).toBeDefined()
    closedTurn(session, 2, 'two')

    session.append('turn/start', { turn: 3 })
    session.append('step/start', { turn: 3, step: 1 })
    const protectedHead = appendSystemHead(session, 3, 1, 'You are Argon. Context window refreshed.', {
      surfaceOp: { op: 'replace', startSeq: originalHead!, endSeq: originalHead! },
      sourceEventSeqs: [originalHead!],
    })
    expect(session.surface.nodes[0]).toBe(protectedHead.seq)
    appendUser(session, 'three')
    appendAssistant(session, 3, 1, [{ type: 'text', text: 'reply 3' }])
    closeTurn(session, 3, 1)
    closedTurn(session, 4, 'four')
    const surface = [...session.surface.nodes]
    expect(surface[0]).toBe(protectedHead.seq)

    appendOmpCompactionBoundary(session, {
      entryId: 'cmp-protected-head',
      summary: 'Earlier conversation summarized',
      tokensBefore: 4096,
    })

    const [summary] = compactionSummaries(session)
    const expected = surface.slice(1)
    expect(summary!.data.shadowedSeqs).toEqual(expected)
    expect(summary!.data.shadowedSeqs).not.toContain(protectedHead.seq)
    expect(summary!.data.shadowedRange).toEqual({ start: expected[0], end: expected.at(-1) })
    expect(session.surface.nodes[0]).toBe(protectedHead.seq)

    await expect(persistAndReopen(session)).resolves.toBeDefined()
  })

  it('returns undefined when the surface holds only a system/message', () => {
    const session = boundarySession('boundary-only-system')
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    appendSystemHead(session, 1, 1, 'You are Argon.')
    const before = session.snapshotEvents().length

    const compactionId = appendOmpCompactionBoundary(session, {
      entryId: 'cmp-only-head',
      summary: 'nothing to shadow',
      tokensBefore: 42,
    })

    expect(compactionId).toBeUndefined()
    expect(session.snapshotEvents()).toHaveLength(before)
  })

  it('shadows the whole surface exactly as before when no system/message exists', () => {
    const session = boundarySession('boundary-no-system')
    closedTurn(session, 1, 'one')
    closedTurn(session, 2, 'two')
    const surface = [...session.surface.nodes]

    appendOmpCompactionBoundary(session, {
      entryId: 'cmp-no-system',
      summary: 'Earlier conversation summarized',
      tokensBefore: 777,
    })

    const [summary] = compactionSummaries(session)
    expect(summary!.data.shadowedSeqs).toEqual(surface)
    expect(summary!.data.shadowedRange).toEqual({ start: surface[0], end: surface.at(-1) })
    expect(session.surface.nodes).toHaveLength(1)
  })

  it('owns compaction events by the open turn and records null between turns', async () => {
    const idle = boundarySession('boundary-idle-owner')
    closedTurn(idle, 1, 'one')
    appendOmpCompactionBoundary(idle, { entryId: 'cmp-idle', summary: 'idle summary', tokensBefore: 100 })
    expect(boundaryOwners(idle)).toEqual([['compaction/start', null], ['compaction/end', null]])

    const open = boundarySession('boundary-open-owner')
    closedTurn(open, 1, 'one')
    open.append('turn/start', { turn: 2 })
    appendUser(open, 'two')
    appendOmpCompactionBoundary(open, { entryId: 'cmp-open', summary: 'open summary', tokensBefore: 200 })
    expect(boundaryOwners(open)).toEqual([['compaction/start', 2], ['compaction/end', 2]])

    await expect(persistAndReopen(open)).resolves.toBeDefined()
  })
})

describe('hydrateOmpSession against a live streaming turn', () => {
  it('keeps the active turn committed transcript prefix with no duplicates and no gaps', async () => {
    const path = await transcript([
      sessionLine(),
      userEntry(entryId(1), SESSION_UUID, 'one'),
      assistantEntry(entryId(2), entryId(1), 'reply 1'),
      userEntry(entryId(3), entryId(2), 'two'),
      {
        type: 'message',
        id: entryId(4),
        parentId: entryId(3),
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'checking' },
            { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: '/tmp/a' } },
          ],
        },
      },
      {
        type: 'message',
        id: entryId(5),
        parentId: entryId(4),
        message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'contents' }], isError: false },
      },
      {
        type: 'message',
        id: entryId(6),
        parentId: entryId(5),
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      },
    ])

    const session = boundarySession('streaming-active-turn')
    closedTurn(session, 1, 'one')
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    appendUser(session, 'two')
    appendAssistant(session, 2, 1, [
      { type: 'text', text: 'checking' },
      { type: 'tool-call', id: ToolCallId('c1'), name: 'read', arguments: JSON.stringify({ path: '/tmp/a' }) },
    ])
    session.append('tool/call', { turn: 2, step: 1, callId: ToolCallId('c1'), name: 'read', arguments: JSON.stringify({ path: '/tmp/a' }) })
    session.append('tool/result', {
      turn: 2,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('c1'),
        content: [{ type: 'text', text: 'contents' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })

    const outcome = await hydrateOmpSession(session, path, Number.POSITIVE_INFINITY, {
      hydratedTurns: 1,
      hydratedLeafEntryId: entryId(2),
      hydratedByteOffset: 0,
    })

    expect(outcome.appended).toBeGreaterThan(0)
    expect(sessionTurnNumbers(session)).toEqual([1, 2])
    expect(sessionUserTexts(session)).toEqual(['one', 'two'])
    expect(assistantTexts(session)).toEqual(['reply 1', 'checking', 'done'])
    expect(session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(1)
    expect(session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(1)
    expect(session.snapshotEvents()
      .filter(event => event.type === 'turn/end')
      .map(event => event.data.turn)).toEqual([1, 2])

    await expect(persistAndReopen(session)).resolves.toBeDefined()
  })
})
