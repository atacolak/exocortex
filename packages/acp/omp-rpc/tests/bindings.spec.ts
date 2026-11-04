import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defaultOmpBindingsFile, OmpBindings, OmpBindingsError, type OmpBinding } from '../src/bindings.ts'

const roots: string[] = []
const OMP_SESSIONS = join(homedir(), '.omp', 'agent', 'sessions', '-workspace')

async function sandbox(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omp-bindings-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('defaultOmpBindingsFile', () => {
  it('places bindings under the resolved harness home', () => {
    expect(defaultOmpBindingsFile('/tmp/dsh-home')).toBe('/tmp/dsh-home/omp/bindings.json')
    vi.stubEnv('DSH_HOME', '/tmp/env-home')
    expect(defaultOmpBindingsFile()).toBe('/tmp/env-home/omp/bindings.json')
  })
})

describe('OmpBindings', () => {
  it('persists a binding across store instances', async () => {
    const file = join(await sandbox(), 'omp', 'bindings.json')
    const binding = {
      ompSessionId: '01a1722b-3e29-7000-b9d5-b05807bbe4b8',
      path: join(OMP_SESSIONS, '01a1722b.jsonl'),
      cwd: join(homedir(), 'workspace'),
      profile: 'argon',
      updatedAt: '2026-11-03T09:09:55.942Z',
    }

    await new OmpBindings(file).set(SessionId('session-1'), binding)

    expect(await new OmpBindings(file).get(SessionId('session-1'))).toEqual(binding)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      sessions: { 'session-1': binding },
      forks: {},
    })
  })

  it('persists a pending branch fork across store instances', async () => {
    const file = join(await sandbox(), 'bindings.json')
    const fork = {
      forkFromPath: join(OMP_SESSIONS, 'parent.jsonl'),
      cwd: join(homedir(), 'workspace'),
      updatedAt: '2026-11-04T00:00:00.000Z',
    }

    await new OmpBindings(file).setFork(SessionId('child'), fork)

    expect(await new OmpBindings(file).getFork(SessionId('child'))).toEqual(fork)
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      forks: { child: fork },
    })
  })

  it('drops a pending fork without touching the resumed bindings', async () => {
    const file = join(await sandbox(), 'bindings.json')
    const store = new OmpBindings(file)
    await store.set(SessionId('child'), {
      ompSessionId: 'omp-child', path: '/child.jsonl', cwd: '/c', updatedAt: '2026-11-04T00:00:00.000Z',
    })
    await store.setFork(SessionId('child'), {
      forkFromPath: '/parent.jsonl', cwd: '/p', updatedAt: '2026-11-04T00:00:00.000Z',
    })

    await store.deleteFork(SessionId('child'))

    expect(await store.getFork(SessionId('child'))).toBeUndefined()
    expect(await store.get(SessionId('child'))).toMatchObject({ ompSessionId: 'omp-child' })
  })

  it('reads a bindings file written before fork records existed', async () => {
    const file = join(await sandbox(), 'bindings.json')
    await writeFile(file, JSON.stringify({ version: 1, sessions: {} }))

    expect(await new OmpBindings(file).getFork(SessionId('child'))).toBeUndefined()
  })

  it('serializes concurrent writes without losing an entry', async () => {
    const file = join(await sandbox(), 'bindings.json')
    const store = new OmpBindings(file)

    await Promise.all([
      store.set(SessionId('a'), {
        ompSessionId: 'omp-a', path: '/a.jsonl', cwd: '/a', updatedAt: '2026-11-03T00:00:00.000Z',
      }),
      store.set(SessionId('b'), {
        ompSessionId: 'omp-b', path: '/b.jsonl', cwd: '/b', updatedAt: '2026-11-03T00:00:01.000Z',
      }),
    ])

    expect(await store.get(SessionId('a'))).toMatchObject({ ompSessionId: 'omp-a' })
    expect(await store.get(SessionId('b'))).toMatchObject({ ompSessionId: 'omp-b' })
  })

  it('deletes one binding and keeps the rest', async () => {
    const file = join(await sandbox(), 'bindings.json')
    const store = new OmpBindings(file)
    await store.set(SessionId('a'), {
      ompSessionId: 'omp-a', path: '/a.jsonl', cwd: '/a', updatedAt: '2026-11-03T00:00:00.000Z',
    })
    await store.set(SessionId('b'), {
      ompSessionId: 'omp-b', path: '/b.jsonl', cwd: '/b', updatedAt: '2026-11-03T00:00:01.000Z',
    })

    await store.delete(SessionId('a'))

    expect(await store.get(SessionId('a'))).toBeUndefined()
    expect(await store.get(SessionId('b'))).toMatchObject({ ompSessionId: 'omp-b' })
  })

  it('reports a corrupt bindings file instead of silently forgetting it', async () => {
    const file = join(await sandbox(), 'bindings.json')
    await writeFile(file, '{not json')

    await expect(new OmpBindings(file).get(SessionId('a'))).rejects.toBeInstanceOf(OmpBindingsError)
  })
})

describe('OmpBindings canonical hydration cursor', () => {
  it('persists the canonical cursor beside the legacy turn count', async () => {
    const file = join(await sandbox(), 'bindings.json')
    const binding = {
      ompSessionId: '01a1722b-3e29-7000-b9d5-b05807bbe4b8',
      path: join(OMP_SESSIONS, '01a1722b.jsonl'),
      cwd: join(homedir(), 'workspace'),
      hydratedTurns: 442,
      hydratedLeafEntryId: '3c90eae0',
      hydratedByteOffset: 40_686_994,
      updatedAt: '2026-11-04T08:42:40.357Z',
    }

    await new OmpBindings(file).set(SessionId('session-1'), binding)

    expect(await new OmpBindings(file).get(SessionId('session-1'))).toEqual(binding)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      sessions: { 'session-1': binding },
      forks: {},
    })
  })

  it('reads a legacy binding that carries only the hydrated turn count', async () => {
    const file = join(await sandbox(), 'bindings.json')
    await writeFile(file, JSON.stringify({
      version: 1,
      sessions: {
        legacy: {
          ompSessionId: '01a1722b-3e29-7000-b9d5-b05807bbe4b8',
          path: '/transcript.jsonl',
          cwd: '/work',
          hydratedTurns: 62,
          updatedAt: '2026-11-03T09:09:55.942Z',
        },
      },
    }))

    expect(await new OmpBindings(file).get(SessionId('legacy'))).toEqual({
      ompSessionId: '01a1722b-3e29-7000-b9d5-b05807bbe4b8',
      path: '/transcript.jsonl',
      cwd: '/work',
      hydratedTurns: 62,
      updatedAt: '2026-11-03T09:09:55.942Z',
    })
  })

  it('rejects a binding whose canonical cursor is malformed', async () => {
    const file = join(await sandbox(), 'bindings.json')
    const valid = {
      ompSessionId: 'omp-1',
      path: '/transcript.jsonl',
      cwd: '/work',
      updatedAt: '2026-11-04T00:00:00.000Z',
    }
    await writeFile(file, JSON.stringify({
      version: 1,
      sessions: { broken: { ...valid, hydratedLeafEntryId: 7 } },
    }))
    await expect(new OmpBindings(file).get(SessionId('broken'))).rejects.toBeInstanceOf(OmpBindingsError)

    const negative = join(await sandbox(), 'bindings.json')
    await writeFile(negative, JSON.stringify({
      version: 1,
      sessions: { broken: { ...valid, hydratedByteOffset: -1 } },
    }))
    await expect(new OmpBindings(negative).get(SessionId('broken'))).rejects.toBeInstanceOf(OmpBindingsError)
  })
})

describe('OmpBindings canonical session keys', () => {
  const bindingOf = (ompSessionId: string): OmpBinding => ({
    ompSessionId,
    path: '/transcript.jsonl',
    cwd: '/work',
    updatedAt: '2026-11-04T00:00:00.000Z',
  })

  it('stores a bare UUID and resolves its session-prefixed twin under one key', async () => {
    const file = join(await sandbox(), 'bindings.json')
    const store = new OmpBindings(file)
    const bare = SessionId('01A0C88E-7521-7000-BB6A-67527D2B6806')
    const prefixed = SessionId('session-01a0c88e-7521-7000-bb6a-67527d2b6806')

    const stored = await store.set(bare, bindingOf('omp-1'))

    expect(stored).toBe(prefixed)
    expect(await store.get(prefixed)).toEqual(bindingOf('omp-1'))
    expect(await store.get(bare)).toEqual(bindingOf('omp-1'))
    expect(Object.keys(JSON.parse(await readFile(file, 'utf8')).sessions)).toEqual([prefixed])
  })

  it('keeps one canonical key when two sessions claim the same OMP session', async () => {
    const file = join(await sandbox(), 'bindings.json')
    const store = new OmpBindings(file)

    const canonical = await store.set(SessionId('session-1'), bindingOf('omp-1'))
    const duplicate = await store.set(SessionId('session-2'), bindingOf('omp-1'))

    expect(canonical).toBe('session-1')
    expect(duplicate).toBe('session-1')
    expect(await store.get(SessionId('session-2'))).toBeUndefined()
    expect(await store.findByOmpSessionId('omp-1')).toEqual({
      sessionId: 'session-1',
      binding: bindingOf('omp-1'),
    })
    expect(Object.keys(JSON.parse(await readFile(file, 'utf8')).sessions)).toEqual(['session-1'])
  })

  it('keeps the hydration cursor when a reattach omits it', async () => {
    const file = join(await sandbox(), 'bindings.json')
    const store = new OmpBindings(file)
    await store.set(SessionId('session-1'), {
      ...bindingOf('omp-1'),
      hydratedTurns: 9,
      hydratedLeafEntryId: 'leaf-9',
      hydratedByteOffset: 12,
    })

    await store.set(SessionId('session-1'), bindingOf('omp-1'))

    expect(await store.get(SessionId('session-1'))).toEqual({
      ...bindingOf('omp-1'),
      hydratedTurns: 9,
      hydratedLeafEntryId: 'leaf-9',
      hydratedByteOffset: 12,
    })
  })
})
