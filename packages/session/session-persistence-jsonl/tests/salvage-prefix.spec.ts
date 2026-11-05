import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { SessionFormatArtifact, SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { logPath } from '../src/format.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const artifactOf = (events: readonly SessionFormatEvent[]): SessionFormatArtifact => ({
  header: { version: 4, id: 'salvage-monotone', createdAt: 1, isSeeded: false, delegationDepth: 0 },
  inheritedEventCount: 0,
  events,
})

const closedTurn = (): SessionFormatEvent[] => [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: 1,
    time: 2,
    data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'one' }] },
    surfaceOp: 'append',
  },
  { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
]

const orphanCompaction = (): SessionFormatEvent => ({
  type: 'compaction/start',
  seq: 3,
  time: 4,
  data: { compactionId: 'c', turn: null, sourceCommandId: 'cmd' },
})

const crossingTurn = (): SessionFormatEvent => ({ type: 'turn/start', seq: 4, time: 5, data: { turn: 2 } })

describe('released relationship validity over prefixes', () => {
  it('accepts a prefix that ends on an orphan compaction/start', () => {
    expect(() => assertReleasedV4Relationships(
      artifactOf([...closedTurn(), orphanCompaction()]),
      KNOWN_SESSION_EVENT_TYPES,
    )).not.toThrow()
  })

  it('rejects only once a later turn crosses that compaction', () => {
    expect(() => assertReleasedV4Relationships(
      artifactOf([...closedTurn(), orphanCompaction(), crossingTurn()]),
      KNOWN_SESSION_EVENT_TYPES,
    )).toThrow('turn/start crosses an open compaction')
  })

  it('keeps every shorter prefix valid when only the tail is invalid', () => {
    const log = [...closedTurn(), orphanCompaction(), crossingTurn()]
    for (let length = 1; length < log.length; length += 1) {
      expect(() => assertReleasedV4Relationships(
        artifactOf(log.slice(0, length)),
        KNOWN_SESSION_EVENT_TYPES,
      )).not.toThrow()
    }
  })

  it('accepts a longer prefix whose session/end-seed reclassifies an earlier compaction', () => {
    const seeded: SessionFormatEvent[] = [
      { type: 'compaction/start', seq: 0, time: 1, data: { compactionId: 'inherited', turn: null, sourceCommandId: 'cmd' } },
      { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
      { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
      { type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'session/end-seed', seq: 5, time: 6, data: { inherited: true } },
    ]

    expect(() => assertReleasedV4Relationships(artifactOf(seeded), KNOWN_SESSION_EVENT_TYPES)).not.toThrow()
    expect(() => assertReleasedV4Relationships(
      artifactOf(seeded.slice(0, -1)),
      KNOWN_SESSION_EVENT_TYPES,
    )).toThrow('turn/start crosses an open compaction')
  })
})

describe('corrupt-log salvage', () => {
  let root: string
  let ctx: Context

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-salvage-'))
    ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('yields the readable prefix when the tail crosses an orphan compaction', async () => {
    const header = meta('salvage-tail', '/work')
    const handle = await ctx.sessionPersistence.create(header)
    try {
      await handle.append(oneTurnLog())
    } finally {
      await handle.close()
    }
    await appendFile(logPath(root, '/work', header.id, 'none'), [
      JSON.stringify({ type: 'compaction/start', seq: 6, time: 7, data: { compactionId: 'c', turn: null, sourceCommandId: 'cmd' } }),
      JSON.stringify({ type: 'turn/start', seq: 7, time: 8, data: { turn: 2 } }),
    ].join('\n') + '\n')

    const failure = await ctx.sessionPersistence.open(header.id, 'read').then(() => undefined, (error: unknown) => error)
    if (!(failure instanceof SessionPersistenceCorruptionError)) throw failure
    const salvaged = failure.salvagedEvents ?? []
    expect(salvaged).toHaveLength(oneTurnLog().length)
    expect(salvaged.map(event => event.type)).toEqual(oneTurnLog().map(event => event.type))
    expect(salvaged.at(-1)?.type).toBe('turn/end')
  })

  it('keeps no prefix when a seed marker lets the longer log validate where a shorter one cannot', async () => {
    const header = meta('salvage-seed', '/work')
    const handle = await ctx.sessionPersistence.create(header)
    try {
      await handle.append(oneTurnLog())
    } finally {
      await handle.close()
    }
    await appendFile(logPath(root, '/work', header.id, 'none'), [
      JSON.stringify({ type: 'compaction/start', seq: 6, time: 7, data: { compactionId: 'c', turn: null, sourceCommandId: 'cmd' } }),
      JSON.stringify({ type: 'turn/start', seq: 7, time: 8, data: { turn: 2 } }),
      JSON.stringify({ type: 'session/end-seed', seq: 8, time: 9, data: { inherited: false } }),
      JSON.stringify({ type: 'turn/end', seq: 9, time: 10, data: { turn: 2, reason: { kind: 'completed' } } }),
      JSON.stringify({ type: 'turn/start', seq: 10, time: 11, data: { turn: 7 } }),
    ].join('\n') + '\n')

    const failure = await ctx.sessionPersistence.open(header.id, 'read').then(() => undefined, (error: unknown) => error)
    if (!(failure instanceof SessionPersistenceCorruptionError)) throw failure
    expect(failure.salvagedEvents ?? []).toEqual([])
  })
})
