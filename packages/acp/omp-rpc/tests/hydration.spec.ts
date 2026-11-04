import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { hydrateOmpBinding, OmpBindings, type OmpBinding } from '../src/bindings.ts'

const roots: string[] = []

const OMP_SESSION = '01a1722b-3e29-7000-b9d5-b05807bbe4b8'
const SESSION_ID = SessionId('session-hydration-cursor')
const EPOCH = Date.parse('2026-11-01T00:00:00.000Z')

function stamp(turn: number): string {
  return new Date(EPOCH + turn * 60_000).toISOString()
}

function entryId(n: number): string {
  return n.toString(16).padStart(8, '0')
}

function sessionLine(): unknown {
  return { type: 'session', version: 3, id: OMP_SESSION, cwd: '/work' }
}

function userEntry(turn: number, parent: string): unknown {
  return {
    type: 'message',
    id: entryId(turn * 2 - 1),
    parentId: parent,
    timestamp: stamp(turn),
    message: { role: 'user', content: [{ type: 'text', text: `turn ${String(turn)}` }] },
  }
}

function assistantEntry(turn: number): unknown {
  return {
    type: 'message',
    id: entryId(turn * 2),
    parentId: entryId(turn * 2 - 1),
    timestamp: stamp(turn),
    message: { role: 'assistant', content: [{ type: 'text', text: `reply ${String(turn)}` }] },
  }
}

function turnEntries(from: number, to: number): unknown[] {
  const lines: unknown[] = []
  for (let turn = from; turn <= to; turn += 1) lines.push(userEntry(turn, turn === 1 ? OMP_SESSION : entryId(turn * 2 - 2)))
  for (let turn = from; turn <= to; turn += 1) lines.push(assistantEntry(turn))
  return lines
}

async function sandbox(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omp-hydration-binding-'))
  roots.push(root)
  return root
}

async function transcript(lines: readonly unknown[]): Promise<string> {
  const path = join(await sandbox(), `2026-11-01T00-00-00-000Z_${OMP_SESSION}.jsonl`)
  await writeFile(path, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)
  return path
}

function bindingOf(path: string): OmpBinding {
  return { ompSessionId: OMP_SESSION, path, cwd: '/work', updatedAt: '2026-11-01T00:00:00.000Z' }
}

function userTexts(session: Session): (string | undefined)[] {
  return session.snapshotEvents()
    .filter(event => event.type === 'user/message')
    .map(event => {
      const block = event.data.content[0]
      return block?.type === 'text' ? block.text : undefined
    })
}

function userTimes(session: Session): number[] {
  return session.snapshotEvents()
    .filter(event => event.type === 'user/message')
    .map(event => event.time)
}

async function storedBinding(file: string): Promise<OmpBinding> {
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || !('sessions' in parsed)) throw new Error('bindings file has no sessions')
  const sessions = parsed.sessions
  if (typeof sessions !== 'object' || sessions === null || !(String(SESSION_ID) in sessions)) {
    throw new Error('bindings file has no entry for the harness session')
  }
  const binding = (sessions as Record<string, unknown>)[String(SESSION_ID)]
  if (typeof binding !== 'object' || binding === null) throw new Error('binding is not an object')
  return binding as OmpBinding
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('hydrateOmpBinding', () => {
  it('hydrates every active-branch turn past the old 200 cap and persists the canonical cursor', async () => {
    const path = await transcript([sessionLine(), ...turnEntries(1, 250)])
    const file = join(await sandbox(), 'omp', 'bindings.json')
    const bindings = new OmpBindings(file)
    const session = Session.create(SESSION_ID)

    const outcome = await hydrateOmpBinding({
      bindings,
      session,
      binding: bindingOf(path),
      includeNewestTurn: true,
    })

    expect(outcome.turns).toBe(250)
    expect(userTexts(session)).toHaveLength(250)
    expect(userTexts(session)[0]).toBe('turn 1')
    expect(userTexts(session).at(-1)).toBe('turn 250')

    const stored = await storedBinding(file)
    expect(stored.hydratedTurns).toBe(250)
    expect(stored.hydratedLeafEntryId).toBe(entryId(500))
    expect(stored.hydratedByteOffset).toBe((await stat(path)).size)
  })

  it('tail-syncs offline CLI turns on reopen and keeps their recorded timestamps', async () => {
    const path = await transcript([sessionLine(), ...turnEntries(1, 3)])
    const file = join(await sandbox(), 'omp', 'bindings.json')
    const session = Session.create(SESSION_ID)

    await hydrateOmpBinding({
      bindings: new OmpBindings(file),
      session,
      binding: bindingOf(path),
      includeNewestTurn: true,
    })
    await appendFile(path, `${turnEntries(4, 5).map(line => JSON.stringify(line)).join('\n')}\n`)

    const reopened = new OmpBindings(file)
    const stored = await reopened.get(SESSION_ID)
    expect(stored).toBeDefined()
    const outcome = await hydrateOmpBinding({
      bindings: reopened,
      session,
      binding: stored!,
      includeNewestTurn: true,
    })

    expect(outcome.appended).toBeGreaterThan(0)
    expect(outcome.turns).toBe(5)
    expect(userTexts(session)).toEqual(['turn 1', 'turn 2', 'turn 3', 'turn 4', 'turn 5'])
    expect(userTimes(session)).toEqual([1, 2, 3, 4, 5].map(turn => Date.parse(stamp(turn))))

    const cursor = await storedBinding(file)
    expect(cursor.hydratedTurns).toBe(5)
    expect(cursor.hydratedLeafEntryId).toBe(entryId(10))
    expect(cursor.hydratedByteOffset).toBe((await stat(path)).size)
  })

  it('reopens an unchanged transcript without appending or moving the cursor', async () => {
    const path = await transcript([sessionLine(), ...turnEntries(1, 2)])
    const file = join(await sandbox(), 'omp', 'bindings.json')
    const session = Session.create(SESSION_ID)

    const first = await hydrateOmpBinding({
      bindings: new OmpBindings(file),
      session,
      binding: bindingOf(path),
      includeNewestTurn: true,
    })
    const before = session.snapshotEvents().length

    const reopened = new OmpBindings(file)
    const again = await hydrateOmpBinding({
      bindings: reopened,
      session,
      binding: (await reopened.get(SESSION_ID))!,
      includeNewestTurn: true,
    })

    expect(again.appended).toBe(0)
    expect(again.hydratedLeafEntryId).toBe(first.hydratedLeafEntryId)
    expect(again.hydratedByteOffset).toBe(first.hydratedByteOffset)
    expect(session.snapshotEvents()).toHaveLength(before)
  })
})
