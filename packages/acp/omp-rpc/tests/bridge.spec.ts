import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { OmpBindings } from '../src/bindings.ts'
import {
  ompLaunchArgv,
  ompLaunchEnvironment,
  ompTodoItems,
  parseOmpCommandInput,
  planOmpAttach,
} from '../src/bridge.ts'

describe('omp commands', () => {
  it('parses a preset and a transcript identity', () => {
    expect(parseOmpCommandInput('builder abc123')).toEqual({
      preset: 'builder',
      sessionId: 'abc123',
    })
  })

  it('parses a lone preset', () => {
    expect(parseOmpCommandInput('builder')).toEqual({ preset: 'builder' })
  })

  it('parses an empty input', () => {
    expect(parseOmpCommandInput('  ')).toEqual({})
  })

  it('starts a fresh transcript when attach names none', () => {
    expect(ompLaunchArgv({ executable: 'omp', mode: 'attach', sessionDir: '/tmp/omp' })).toEqual([
      'omp', '--mode', 'rpc', '--session-dir', '/tmp/omp',
    ])
  })

  it('resumes an explicit transcript for attach', () => {
    expect(ompLaunchArgv({ executable: 'omp', mode: 'attach', sessionDir: '/tmp/omp', sessionId: 's1', preset: 'builder' })).toEqual([
      'omp', '--mode', 'rpc', '--session-dir', '/tmp/omp', '--agent', 'builder', '--resume', 's1',
    ])
  })

  it('never passes a resume flag when forking', () => {
    expect(ompLaunchArgv({ executable: 'omp', mode: 'fork', sessionDir: '/tmp/omp', sessionId: 's1' })).toEqual([
      'omp', '--mode', 'rpc', '--session-dir', '/tmp/omp',
    ])
  })

  it('forks the attached transcript natively', () => {
    expect(ompLaunchArgv({ executable: 'omp', mode: 'fork', sessionDir: '/tmp/omp', forkPath: '/tmp/s.jsonl' })).toEqual([
      'omp', '--mode', 'rpc', '--session-dir', '/tmp/omp', '--fork', '/tmp/s.jsonl',
    ])
  })
})

describe('omp launch extensions', () => {
  it('mounts extension modules before the RPC mode', () => {
    expect(ompLaunchArgv({
      executable: 'omp', mode: 'attach', sessionDir: '/tmp/omp', extensions: ['/home/x/hcom.ts'],
    })).toEqual([
      'omp', '-e', '/home/x/hcom.ts', '--mode', 'rpc', '--session-dir', '/tmp/omp',
    ])
  })

  it('marks every launch as an Exocortex origin', () => {
    expect(ompLaunchEnvironment()).toEqual({ EXOCORTEX_ENV: '1' })
  })

  it('binds the launch into hcom when the binder extension is mounted', () => {
    expect(ompLaunchEnvironment({ hcom: true })).toEqual({
      EXOCORTEX_ENV: '1',
      HCOM_LAUNCHED: '1',
    })
  })
})

describe('omp transcript planning', () => {
  const roots: string[] = []
  const session = (id: string): SessionId => SessionId(id)

  async function workdir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'omp-plan-'))
    roots.push(root)
    return root
  }

  async function transcript(root: string, name: string): Promise<string> {
    const path = join(root, name)
    await writeFile(path, '')
    return path
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  it('resumes the transcript this session already owns', async () => {
    const root = await workdir()
    const bindings = new OmpBindings(join(root, 'bindings.json'))
    const path = await transcript(root, 'own.jsonl')
    await bindings.set(session('child'), {
      ompSessionId: 'omp-own', path, cwd: root, updatedAt: '2026-11-04T00:00:00.000Z',
    })
    expect(await planOmpAttach({ sessionId: session('child'), bindings })).toEqual({
      mode: 'attach', resumePath: path,
    })
  })

  it('forks the recorded branch parent when this session owns no transcript', async () => {
    const root = await workdir()
    const bindings = new OmpBindings(join(root, 'bindings.json'))
    const path = await transcript(root, 'parent.jsonl')
    await bindings.setFork(session('child'), {
      forkFromPath: path, cwd: root, updatedAt: '2026-11-04T00:00:00.000Z',
    })
    expect(await planOmpAttach({ sessionId: session('child'), bindings })).toEqual({
      mode: 'fork', forkPath: path,
    })
  })

  it('starts fresh when the recorded branch parent is gone', async () => {
    const root = await workdir()
    const bindings = new OmpBindings(join(root, 'bindings.json'))
    await bindings.setFork(session('child'), {
      forkFromPath: join(root, 'missing.jsonl'), cwd: root, updatedAt: '2026-11-04T00:00:00.000Z',
    })
    expect(await planOmpAttach({ sessionId: session('child'), bindings })).toEqual({
      mode: 'attach',
    })
  })

  it('prefers an own transcript over the recorded branch parent', async () => {
    const root = await workdir()
    const bindings = new OmpBindings(join(root, 'bindings.json'))
    const own = await transcript(root, 'own.jsonl')
    const parent = await transcript(root, 'parent.jsonl')
    await bindings.set(session('child'), {
      ompSessionId: 'omp-own', path: own, cwd: root, updatedAt: '2026-11-04T00:00:00.000Z',
    })
    await bindings.setFork(session('child'), {
      forkFromPath: parent, cwd: root, updatedAt: '2026-11-04T00:00:00.000Z',
    })
    expect(await planOmpAttach({ sessionId: session('child'), bindings })).toEqual({
      mode: 'attach', resumePath: own,
    })
  })
})

describe('omp todo projection', () => {
  it('maps active phases and drops passive ones', () => {
    expect(ompTodoItems({
      todoPhases: [
        {
          name: 'Plan',
          kind: 'continuing',
          tasks: [
            { content: 'read the code', status: 'completed' },
            { content: 'write the fix', status: 'in_progress' },
            { content: 'run tests', status: 'pending' },
            { content: 'dropped work', status: 'abandoned' },
            { content: 'waiting on peer', status: 'blocked' },
          ],
        },
        { name: 'Notes', kind: 'passive', tasks: [{ content: 'not a task', status: 'pending' }] },
      ],
    })).toEqual([
      { content: 'read the code', status: 'completed' },
      { content: 'write the fix', status: 'in_progress' },
      { content: 'run tests', status: 'pending' },
      { content: 'dropped work', status: 'pending' },
      { content: 'waiting on peer', status: 'pending' },
    ])
  })

  it('reports no todos for a state without phases', () => {
    expect(ompTodoItems({ sessionId: 's1' })).toEqual([])
    expect(ompTodoItems(undefined)).toEqual([])
  })
})
