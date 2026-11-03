import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { OmpBindings } from '../src/bindings.ts'
import {
  OmpBridge,
  ompLaunchArgv,
  ompLaunchEnvironment,
  ompTodoItems,
  parseOmpCommandInput,
  planOmpAttach,
} from '../src/bridge.ts'
import { tick } from './harness.ts'

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
  it('maps every phase and prefixes task content by phase name', () => {
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
      { content: '[Plan] read the code', status: 'completed' },
      { content: '[Plan] write the fix', status: 'in_progress' },
      { content: '[Plan] run tests', status: 'pending' },
      { content: '[Plan] dropped work', status: 'pending' },
      { content: '[Plan] [blocked] waiting on peer', status: 'pending' },
      { content: '[Notes] not a task', status: 'pending' },
    ])
  })

  it('keeps a single passive phase visible with its phase label', () => {
    expect(ompTodoItems({
      todoPhases: [
        { name: 'For operator', kind: 'passive', tasks: [{ content: 'review the diff', status: 'blocked' }] },
      ],
    })).toEqual([{ content: '[For operator] [blocked] review the diff', status: 'pending' }])
  })

  it('reports no todos for a state without phases', () => {
    expect(ompTodoItems({ sessionId: 's1' })).toEqual([])
    expect(ompTodoItems(undefined)).toEqual([])
  })
})

interface FakeOmp {
  readonly subprocess: SubprocessRuntime
  readonly requests: Record<string, unknown>[]
}

function fakeOmp(reply: (frame: Record<string, unknown>, send: (frame: unknown) => void) => unknown): FakeOmp {
  const requests: Record<string, unknown>[] = []
  const subprocess = {
    resolveExecutable: async (command: string) => command,
    spawn: (): SubprocessHandle => {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      stdout.write(`${JSON.stringify({
        type: 'ready',
        protocolVersion: 1,
        supportedProtocolVersions: [1],
        maxFrameBytes: 1024 * 1024,
      })}\n`)
      let buffered = ''
      stdin.setEncoding('utf8')
      stdin.on('data', (chunk: string) => {
        buffered += chunk
        let newline = buffered.indexOf('\n')
        while (newline !== -1) {
          const line = buffered.slice(0, newline)
          buffered = buffered.slice(newline + 1)
          const frame = JSON.parse(line) as Record<string, unknown>
          requests.push(frame)
          const data = reply(frame, (extra) => { stdout.write(`${JSON.stringify(extra)}\n`) })
          stdout.write(`${JSON.stringify({
            type: 'response',
            id: frame.id,
            command: frame.type,
            success: true,
            ...data === undefined ? {} : { data },
          })}\n`)
          newline = buffered.indexOf('\n')
        }
      })
      const exited = Promise.withResolvers<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
      return {
        stdin,
        stdout,
        stderr: undefined,
        control: undefined,
        collected: {},
        done: exited.promise,
        terminate: () => { exited.resolve({ exitCode: 0, signal: null }) },
        waitForExit: async () => true,
      } as unknown as SubprocessHandle
    },
  } as unknown as SubprocessRuntime
  return { subprocess, requests }
}

async function mountedBridge(reply: Parameters<typeof fakeOmp>[0]): Promise<{
  ctx: Context
  bridge: OmpBridge
  bridgeCtx: Context
  subprocess: SubprocessRuntime
}> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  ctx.provide('tools', { definitions: () => [] } as never)
  const { subprocess } = fakeOmp(reply)
  ctx.provide('subprocess', subprocess as never)
  let bridgeCtx!: Context
  await ctx.plugin(Object.assign((inner: Context) => { bridgeCtx = inner }, {
    inject: ['commands', 'subprocess', 'tools'],
  }))
  const bridge = new OmpBridge({ ctx: bridgeCtx, subprocess, executable: 'omp' })
  onTestFinished(() => bridge.dispose())
  return { ctx, bridge, bridgeCtx, subprocess }
}

async function scopedAgent(ctx: Context, id: string): Promise<Agent> {
  const session = Session.create(SessionId(id))
  const agent = { id: session.id, session, model: { current: () => undefined } } as unknown as Agent
  const scope = createScope(ctx, agent)
  ;(agent as unknown as { ctx: Context }).ctx = scope.ctx
  return agent
}

describe('OmpBridge command registration', () => {
  it('registers /compact and /omp on an agent scope that never injected commands', async () => {
    const { ctx, bridge } = await mountedBridge((frame, send) => {
      if (frame.type === 'get_state') return { sessionId: 'omp-session-1' }
      if (frame.type === 'get_available_models') return { models: [] }
      if (frame.type === 'get_available_commands') {
        return {
          commands: [
            { name: 'status', description: 'Show OMP status', input: { hint: '[args]' }, source: 'builtin' },
            { name: 'compact', description: 'Native compact', source: 'builtin' },
            { name: 'model', description: 'Native model picker', source: 'builtin' },
          ],
        }
      }
      if (frame.type === 'compact') return { tokensBefore: 42 }
      if (frame.type === 'prompt') {
        send({ type: 'command_output', text: 'OMP status ok' })
        return { agentInvoked: false }
      }
      return {}
    })
    const agent = await scopedAgent(ctx, 'bridge-commands')
    const sessionDir = await mkdtemp(join(tmpdir(), 'omp-attach-'))
    onTestFinished(() => rm(sessionDir, { recursive: true, force: true }))

    const attachment = await bridge.attach(agent, { mode: 'attach', sessionDir, cwd: '/work' })
    await tick()

    expect(attachment.session.id).toBe('omp-session-1')
    expect(ctx.commands.list(agent).map(descriptor => descriptor.name)).toEqual(['compact', 'model', 'omp', 'status'])

    const signal = new AbortController().signal
    const compact = await ctx.commands.execute(agent, '/compact', [], signal)
    expect(compact?.result).toEqual({ kind: 'success', text: 'Compacted OMP context (42 tokens before).' })

    const omp = await ctx.commands.execute(agent, '/omp status', [], signal)
    expect(omp?.result).toEqual({ kind: 'success', text: 'OMP status ok' })

    const native = await ctx.commands.execute(agent, '/status now', [], signal)
    expect(native?.result).toEqual({ kind: 'success', text: 'OMP status ok' })

    await bridge.detach(agent.id)
  })
})

describe('OmpBridge image resolution', () => {
  it('reads pasted images through the attachment lookup without injecting the service', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const readImage = async (): Promise<{ data: Uint8Array }> => ({ data: new Uint8Array([1, 2, 3]) })
    await ctx.plugin({
      name: 'test-attachments',
      apply: (inner: Context) => { inner.provide('attachments', { readImage } as never) },
    })
    ctx.provide('tools', { definitions: () => [] } as never)
    ctx.provide('commands', { register: () => () => {} } as never)
    const { subprocess } = fakeOmp(() => ({}))
    ctx.provide('subprocess', subprocess as never)
    let bridgeCtx!: Context
    await ctx.plugin(Object.assign((inner: Context) => { bridgeCtx = inner }, {
      inject: ['commands', 'subprocess', 'tools'],
    }))
    expect(() => bridgeCtx.attachments).toThrow(/without inject/)
    const bridge = new OmpBridge({ ctx: bridgeCtx, subprocess, executable: 'omp' })

    const readImages = (bridge as unknown as {
      readImages(refs: readonly unknown[]): Promise<readonly { data: string; mimeType: string }[]>
    }).readImages.bind(bridge)
    const images = await readImages([{ mediaType: 'image/png' }])

    expect(images).toEqual([{ data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png' }])
  })
})
