import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { OmpBindings } from '../src/bindings.ts'
import type { OmpAgentDriver } from '../src/driver.ts'
import { ompSocketPath } from '../src/socket.ts'
import {
  OmpBridge,
  ompLaunchArgv,
  ompLaunchEnvironment,
  ompTodoItems,
  planOmpAttach,
  resolveOmpExecutable,
} from '../src/bridge.ts'
import { fakeSessionServer, tick, type FakeSessionServer } from './harness.ts'

describe('OMP executable resolution', () => {
  it('prefers the configured executable over OMP_BIN', () => {
    expect(resolveOmpExecutable('/opt/omp', { OMP_BIN: '/env/omp' })).toBe('/opt/omp')
  })

  it('follows OMP_BIN when no executable is configured', () => {
    expect(resolveOmpExecutable(undefined, { OMP_BIN: '/env/omp' })).toBe('/env/omp')
  })

  it('defaults to omp on PATH', () => {
    expect(resolveOmpExecutable(undefined, {})).toBe('omp')
  })
})

describe('omp commands', () => {
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

  it('pins the OMP run directory so the child cannot publish under the process home', () => {
    expect(ompLaunchEnvironment({ runDirectory: '/stage/omp-run' })).toEqual({
      EXOCORTEX_ENV: '1',
      OMP_RUN_DIR: '/stage/omp-run',
    })
  })
})

describe('OmpBridge run directory pinning', () => {
  it('carries the bridge run directory into the launched OMP environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omp-pin-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const runDirectory = join(root, 'omp-run')
    const { ctx, bridge, spawned } = await mountedBridge((frame) => {
      if (frame.type === 'get_state') return { sessionId: 'omp-pinned-1', cwd: root }
      if (frame.type === 'get_available_models') return { models: [] }
      if (frame.type === 'get_available_commands') return { commands: [] }
      return {}
    }, { runDirectory })
    const agent = await scopedAgent(ctx, 'harness-pinned')
    await bridge.attach(agent, { mode: 'attach', sessionDir: join(root, 'sessions'), cwd: root })

    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.env.OMP_RUN_DIR).toBe(runDirectory)
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
  /** Every process the bridge asked the provider to start. */
  readonly spawned: { readonly argv: readonly string[]; readonly env: Record<string, string> }[]
  /** Push one unsolicited frame, as a lifecycle or model switch event does. */
  readonly send: (frame: unknown) => void
}

interface FakeSpawnRequest {
  readonly argv: readonly string[]
  readonly env?: Record<string, string> | undefined
}

function fakeOmp(reply: (frame: Record<string, unknown>, send: (frame: unknown) => void) => unknown): FakeOmp {
  const requests: Record<string, unknown>[] = []
  const outputs: PassThrough[] = []
  const spawned: { readonly argv: readonly string[]; readonly env: Record<string, string> }[] = []
  const subprocess = {
    resolveExecutable: async (command: string) => command,
    spawn: (request: FakeSpawnRequest): SubprocessHandle => {
      spawned.push({ argv: request.argv, env: request.env ?? {} })
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      outputs.push(stdout)
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
          let data: unknown
          let failure: string | undefined
          try {
            data = reply(frame, (extra) => { stdout.write(`${JSON.stringify(extra)}\n`) })
          } catch (error: unknown) {
            failure = error instanceof Error ? error.message : String(error)
          }
          stdout.write(`${JSON.stringify({
            type: 'response',
            id: frame.id,
            command: frame.type,
            ...failure === undefined
              ? { success: true, ...data === undefined ? {} : { data } }
              : { success: false, error: failure },
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
  return {
    subprocess,
    requests,
    spawned,
    send: (frame) => {
      for (const output of outputs) output.write(`${JSON.stringify(frame)}\n`)
    },
  }
}

async function mountedBridge(
  reply: Parameters<typeof fakeOmp>[0],
  options: { readonly runDirectory?: string } = {},
): Promise<{
  ctx: Context
  bridge: OmpBridge
  bridgeCtx: Context
  subprocess: SubprocessRuntime
  requests: Record<string, unknown>[]
  spawned: FakeOmp['spawned']
  send: FakeOmp['send']
}> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  ctx.provide('tools', { definitions: () => [] } as never)
  const { subprocess, requests, spawned, send } = fakeOmp(reply)
  ctx.provide('subprocess', subprocess as never)
  let bridgeCtx!: Context
  await ctx.plugin(Object.assign((inner: Context) => { bridgeCtx = inner }, {
    inject: ['commands', 'subprocess', 'tools'],
  }))
  const bridge = new OmpBridge({
    ctx: bridgeCtx,
    subprocess,
    executable: 'omp',
    detachedDaemon: false,
    ...options.runDirectory === undefined ? {} : { runDirectory: options.runDirectory },
  })
  onTestFinished(() => bridge.dispose())
  return { ctx, bridge, bridgeCtx, subprocess, requests, spawned, send }
}

async function scopedAgent(ctx: Context, id: string): Promise<Agent> {
  const session = Session.create(SessionId(id))
  const agent = { id: session.id, session, model: { current: () => undefined } } as unknown as Agent
  const scope = createScope(ctx, agent)
  ;(agent as unknown as { ctx: Context }).ctx = scope.ctx
  return agent
}

describe('OmpBridge command registration', () => {
  it('registers /compact and discovered native commands on an agent scope that never injected commands', async () => {
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
    expect(ctx.commands.list(agent).map(descriptor => descriptor.name)).toEqual(['compact', 'status'])

    const signal = new AbortController().signal
    const compact = await ctx.commands.execute(agent, '/compact', [], signal)
    expect(compact?.result).toEqual({ kind: 'success', text: 'Compacted OMP context (42 tokens before).' })

    const native = await ctx.commands.execute(agent, '/status now', [], signal)
    expect(native?.result).toEqual({ kind: 'success', text: 'OMP status ok' })

    await bridge.detach(agent.id)
  })

  it('drops one malformed catalog row and still registers the rest', async () => {
    const { ctx, bridge, bridgeCtx } = await mountedBridge((frame) => {
      if (frame.type === 'get_state') return { sessionId: 'omp-session-2' }
      if (frame.type === 'get_available_models') return { models: [] }
      if (frame.type === 'get_available_commands') {
        return {
          commands: [
            { name: 'a:b:c', description: 'Two namespaces deep', source: 'extension' },
            { name: 'status', description: 'Show OMP status', source: 'builtin' },
            { name: 'skill:workflows', description: 'Namespaced skill', source: 'skill' },
          ],
        }
      }
      return {}
    })
    const warn = vi.spyOn(bridgeCtx.logger, 'warn').mockImplementation(() => {})
    const agent = await scopedAgent(ctx, 'bridge-commands-malformed')
    const sessionDir = await mkdtemp(join(tmpdir(), 'omp-attach-'))
    onTestFinished(() => rm(sessionDir, { recursive: true, force: true }))

    await bridge.attach(agent, { mode: 'attach', sessionDir, cwd: '/work' })
    await tick()

    expect(ctx.commands.list(agent).map(descriptor => descriptor.name)).toEqual(['compact', 'skill:workflows', 'status'])
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('cannot register native command "a:b:c"'))

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
    const bridge = new OmpBridge({ ctx: bridgeCtx, subprocess, executable: 'omp', detachedDaemon: false })

    const readImages = (bridge as unknown as {
      readImages(refs: readonly unknown[]): Promise<readonly { type: string; data: string; mimeType: string }[]>
    }).readImages.bind(bridge)
    const images = await readImages([{ mediaType: 'image/png' }])

    expect(images).toEqual([
      { type: 'image', data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png' },
    ])
  })
})

describe('OmpBridge live socket attachment', () => {
  const servers = new Set<FakeSessionServer>()
  const directories = new Set<string>()
  afterEach(async () => {
    for (const server of servers) await server.close()
    servers.clear()
    for (const directory of directories) await rm(directory, { recursive: true, force: true })
    directories.clear()
  })

  async function socketBridge(): Promise<{ ctx: Context; bridge: OmpBridge }> {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    ctx.provide('tools', { definitions: () => [] } as never)
    const subprocess = {
      resolveExecutable: async (command: string) => command,
      spawn: () => { throw new Error('the bridge must not launch OMP for a live socket attach') },
    }
    ctx.provide('subprocess', subprocess as never)
    let bridgeCtx!: Context
    await ctx.plugin(Object.assign((inner: Context) => { bridgeCtx = inner }, {
      inject: ['commands', 'subprocess', 'tools'],
    }))
    const bridge = new OmpBridge({ ctx: bridgeCtx, subprocess: subprocess as never, executable: 'omp', detachedDaemon: false })
    onTestFinished(() => bridge.dispose())
    return { ctx, bridge }
  }

  async function published(ompSessionId = 'omp-live-1'): Promise<{ directory: string; server: FakeSessionServer; frames: Record<string, unknown>[] }> {
    const directory = await mkdtemp(join(tmpdir(), 'omp-socket-'))
    directories.add(directory)
    const frames: Record<string, unknown>[] = []
    const server = await fakeSessionServer(ompSocketPath(directory, ompSessionId), (frame) => {
      frames.push(frame)
      if (frame.type === 'get_state') return { sessionId: ompSessionId, sessionFile: `/transcripts/${ompSessionId}.jsonl` }
      if (frame.type === 'get_available_models') return { models: [] }
      if (frame.type === 'get_available_commands') return { commands: [] }
      return {}
    })
    servers.add(server)
    await writeFile(join(directory, `${ompSessionId}.json`), JSON.stringify({
      pid: process.pid,
      sessionId: ompSessionId,
      sessionFile: `/transcripts/${ompSessionId}.jsonl`,
      cwd: '/work',
      startedAt: Date.now(),
    }))
    return { directory, server, frames }
  }

  it('attaches a live session socket without launching a process', async () => {
    const { ctx, bridge } = await socketBridge()
    const { directory, server } = await published()
    const agent = await scopedAgent(ctx, 'socket-a')

    const attachment = await bridge.attach(agent, {
      mode: 'attach',
      sessionDir: directory,
      socketPath: ompSocketPath(directory, 'omp-live-1'),
      sessionId: 'omp-live-1',
      cwd: '/work',
    })

    expect(attachment.launched).toBeUndefined()
    expect(attachment.session.id).toBe('omp-live-1')
    expect(attachment.client.protocol).toBe(1)
    expect(bridge.servesOmpSession('omp-live-1')).toBe(true)
    expect(bridge.attached(agent.id)).toBe(true)
    expect(server.open).toBe(1)

    await bridge.detach(agent.id)
    expect(bridge.attached(agent.id)).toBe(false)
    await expect.poll(() => server.open, { timeout: 2_000 }).toBe(0)
  })

  it('switches to a named OMP session by binding a new process, never restarting the old one', async () => {
    const { ctx, bridge } = await socketBridge()
    const from = await published('omp-live-from')
    const to = await published('omp-live-to')
    const agent = await scopedAgent(ctx, 'socket-switch')

    await bridge.attach(agent, {
      mode: 'attach',
      sessionDir: from.directory,
      socketPath: ompSocketPath(from.directory, 'omp-live-from'),
      sessionId: 'omp-live-from',
      cwd: '/work',
    })
    const before = bridge.driverOf(agent.id)
    await bridge.attach(agent, {
      mode: 'attach',
      sessionDir: to.directory,
      socketPath: ompSocketPath(to.directory, 'omp-live-to'),
      sessionId: 'omp-live-to',
      cwd: '/work',
    })
    const after = bridge.driverOf(agent.id)

    expect(before).toBeDefined()
    expect(after).toBeDefined()
    expect(after).not.toBe(before)
    expect(from.frames.filter(frame => frame.type === 'new_session')).toEqual([])
    expect(bridge.servesOmpSession('omp-live-from')).toBe(false)
    expect(bridge.servesOmpSession('omp-live-to')).toBe(true)
    await expect.poll(() => from.server.open, { timeout: 2_000 }).toBe(0)
  })

  it('refuses a socket publishing a different session than requested', async () => {
    const { ctx, bridge } = await socketBridge()
    const { directory } = await published('omp-live-2')
    const agent = await scopedAgent(ctx, 'socket-b')
    await expect(bridge.attach(agent, {
      mode: 'attach',
      sessionDir: directory,
      socketPath: ompSocketPath(directory, 'omp-live-2'),
      sessionId: 'omp-other',
      cwd: '/work',
    })).rejects.toThrow(/serves session "omp-live-2", not "omp-other"/)
    expect(bridge.attached(agent.id)).toBe(false)
  })

  it('refuses to serve one OMP session from two harness sessions', async () => {
    const { ctx, bridge } = await socketBridge()
    const { directory } = await published()
    const first = await scopedAgent(ctx, 'socket-c')
    const second = await scopedAgent(ctx, 'socket-d')
    const options = {
      mode: 'attach' as const,
      sessionDir: directory,
      socketPath: ompSocketPath(directory, 'omp-live-1'),
      sessionId: 'omp-live-1',
      cwd: '/work',
    }
    await bridge.attach(first, options)
    await expect(bridge.attach(second, options)).rejects.toThrow(/already attached to harness session "socket-c"/)
    expect(bridge.attached(first.id)).toBe(true)
    expect(bridge.attached(second.id)).toBe(false)
  })

  it('never replays a historical unanswered user message into an attached socket', async () => {
    const { ctx, bridge } = await socketBridge()
    const { directory, frames } = await published('omp-live-stale')
    const agent = await scopedAgent(ctx, 'socket-stale')
    const stale = createUserMessage({ content: [{ type: 'text', text: 'want Option B in Wave 2' }], source: { kind: 'user' } })
    agent.session.append('user/message', stale, { surfaceOp: 'append' })

    await bridge.attach(agent, {
      mode: 'attach',
      sessionDir: directory,
      socketPath: ompSocketPath(directory, 'omp-live-stale'),
      sessionId: 'omp-live-stale',
      cwd: '/work',
    })

    const live = (bridge as unknown as { attachments: Map<string, { driver: OmpAgentDriver }> }).attachments.get(agent.id)
    expect(live).toBeDefined()
    const chunks: StreamChunk[] = []
    for await (const chunk of live?.driver.stream(
      { provider: 'omp', model: 'omp', messages: [stale] },
      new AbortController().signal,
    ) ?? []) chunks.push(chunk)

    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
    expect(frames.filter(frame => frame.type === 'prompt' || frame.type === 'steer')).toEqual([])
  })

  it('advertises a live tool call in an assistant message before projecting it', async () => {
    const { ctx, bridge } = await socketBridge()
    const { directory } = await published('omp-live-tool')
    const agent = await scopedAgent(ctx, 'socket-tool')
    await bridge.attach(agent, {
      mode: 'attach',
      sessionDir: directory,
      socketPath: ompSocketPath(directory, 'omp-live-tool'),
      sessionId: 'omp-live-tool',
      cwd: '/work',
    })

    agent.session.append('turn/start', { turn: 3 })
    agent.session.append('step/start', { turn: 3, step: 1 })
    agent.session.append('assistant/message', {
      turn: 3,
      step: 1,
      message: { id: 'empty-assistant', role: 'assistant', content: [], source: { kind: 'model', provider: 'cpa', model: 'gemini' } } as never,
      stream: [],
    }, { surfaceOp: 'append' })

    const live = (bridge as unknown as {
      attachments: Map<string, { agent: Agent; cursor: { turn: number; step: number } }>
      projectTool(live: unknown, event: unknown): void
    }).attachments.get(agent.id)
    expect(live).toBeDefined()
    const project = (bridge as unknown as { projectTool(live: unknown, event: unknown): void }).projectTool.bind(bridge)
    live!.cursor.turn = 3
    live!.cursor.step = 1
    project(live, { kind: 'start', toolCallId: 'call_live_1', toolName: 'bash', arguments: { command: 'uptime' } })
    project(live, { kind: 'start', toolCallId: 'call_live_1', toolName: 'bash', arguments: { command: 'uptime' } })

    const events = agent.session.snapshotEvents()
    const callIndex = events.findIndex(event => event.type === 'tool/call')
    expect(callIndex).toBeGreaterThan(0)
    const call = events[callIndex]
    expect(call?.type === 'tool/call' && call.data.arguments).toBe('{"command":"uptime"}')
    const advertised = events.slice(0, callIndex).reverse().find(event => event.type === 'assistant/message')
    expect(advertised?.type === 'assistant/message' && advertised.data.message.content).toEqual([
      { type: 'tool-call', id: 'call_live_1', name: 'bash', arguments: '{"command":"uptime"}' },
    ])
    expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(2)
  })

  it('aborts OMP only for an operator cancel, never for a teardown abort', async () => {
    const { ctx, bridge } = await socketBridge()
    const { directory, frames } = await published('omp-live-cancel')
    const agent = await scopedAgent(ctx, 'socket-cancel')
    await bridge.attach(agent, {
      mode: 'attach',
      sessionDir: directory,
      socketPath: ompSocketPath(directory, 'omp-live-cancel'),
      sessionId: 'omp-live-cancel',
      cwd: '/work',
    })

    const live = (bridge as unknown as { attachments: Map<string, object> }).attachments.get(agent.id)
    if (live === undefined) throw new Error('expected an attached OMP session')
    const stream = (bridge as unknown as {
      liveStream(live: object, request: GenerateOptions, signal: AbortSignal): AsyncIterable<StreamChunk>
    }).liveStream.bind(bridge)
    const run = (text: string, signal: AbortSignal): Promise<void> => (async () => {
      const request = {
        provider: 'omp',
        model: 'omp',
        messages: [createUserMessage({ content: [{ type: 'text' as const, text }], source: { kind: 'user' as const } })],
      }
      for await (const _chunk of stream(live, request, signal)) { /* drain */ }
    })()

    const teardown = new AbortController()
    const drained = run('first', teardown.signal)
    await tick()
    teardown.abort({ kind: 'disposed' })
    await drained
    await tick()
    expect(frames.filter(frame => frame.type === 'abort')).toEqual([])

    const operator = new AbortController()
    const cancelled = run('second', operator.signal)
    await tick()
    operator.abort({ kind: 'user' })
    await cancelled
    await expect.poll(() => frames.filter(frame => frame.type === 'abort').length).toBe(1)
  })
})

/**
 * Poll the assertion until it holds, so a projection that lands after the frame
 * is observed on the next tick is not reported as a failure.
 * @param predicate - the condition the projection should reach.
 */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await tick()
  }
  throw new Error('condition did not hold')
}

describe('OMP model authority', () => {
  const DSH_DEFAULT: ModelSelection = { provider: 'deepseek-official', model: 'deepseek-flash' }
  const OPUS_4 = { provider: 'cpa', id: 'claude-opus-4-6', name: 'Claude Opus 4.6' }
  const OPUS_5 = { provider: 'cpa', id: 'claude-opus-5', name: 'Claude Opus 5' }
  const GLM = { provider: 'opencode-go', id: 'go/glm-5', name: 'GLM 5' }

  interface ModelDouble {
    current(): ModelSelection | undefined
    select(selection: ModelSelection): void
  }

  /**
   * Build an agent whose session publishes on the root ctx, so the bridge's
   * `session/event` subscription sees the selections the badge records.
   * @param ctx - root context the bridge was mounted on.
   * @param id - session identity.
   * @param initial - the model the harness believed before attaching.
   */
  async function modelAgent(ctx: Context, id: string, initial?: ModelSelection): Promise<{ agent: Agent; session: Session; model: ModelDouble }> {
    const session = ctx.sessions.create(SessionId(id))
    let recorded = initial
    const model: ModelDouble = {
      current: () => recorded,
      select: (selection) => {
        if (recorded !== undefined
          && recorded.provider === selection.provider
          && recorded.model === selection.model
          && recorded.reasoningEffort === selection.reasoningEffort) return
        recorded = selection
        session.append('model/selection', selection)
      },
    }
    const agent = { id: session.id, session, model } as unknown as Agent
    ;(agent as unknown as { ctx: Context }).ctx = ctx
    return { agent, session, model }
  }

  /**
   * Script an OMP process that owns one model state and answers the authority
   * reads the bridge makes, including a rejected write when asked.
   * @param options - initial authority, served models, and commands to refuse.
   */
  function scriptedOmp(options: {
    readonly state: { provider: string; id: string; thinkingLevel?: string }
    readonly models: readonly Record<string, unknown>[]
    readonly reject?: readonly string[]
  }): (frame: Record<string, unknown>, send: (frame: unknown) => void) => unknown {
    const state = options.state
    const rejected = new Set(options.reject ?? [])
    return (frame, send) => {
      const type = String(frame.type)
      if (rejected.has(type)) throw new Error(`${type} is not available`)
      switch (type) {
        case 'get_state':
          return {
            sessionId: 'omp-model',
            model: { provider: state.provider, id: state.id },
            ...state.thinkingLevel === undefined ? {} : { thinkingLevel: state.thinkingLevel },
          }
        case 'get_available_models':
          return { models: options.models }
        case 'set_model': {
          const next = options.models.find(model => model.provider === frame.provider && model.id === frame.modelId)
          if (next === undefined) throw new Error(`Model not found: ${String(frame.provider)}/${String(frame.modelId)}`)
          state.provider = String(next.provider)
          state.id = String(next.id)
          send({ type: 'model_changed' })
          return {}
        }
        case 'set_thinking_level':
          state.thinkingLevel = String(frame.level)
          send({ type: 'thinking_level_changed', thinkingLevel: state.thinkingLevel })
          return {}
        default:
          return {}
      }
    }
  }

  /** Every write the bridge sent to the process. */
  function writes(requests: readonly Record<string, unknown>[]): Record<string, unknown>[] {
    return requests.filter(request => request.type === 'set_model' || request.type === 'set_thinking_level')
  }

  /** The model the session badge currently reports. */
  function badge(session: Session): unknown {
    return session.snapshotEvents().filter(event => event.type === 'model/selection').at(-1)?.data
  }

  async function sessionDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'omp-attach-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    return dir
  }

  it('never writes a model frame when attaching to a session whose OMP state already names one', async () => {
    const reply = scriptedOmp({
      state: { provider: 'cpa', id: 'claude-opus-4-6', thinkingLevel: 'high' },
      models: [OPUS_4, GLM],
    })
    const { ctx, bridge, requests } = await mountedBridge(reply)
    const { agent, session } = await modelAgent(ctx, 'omp-model-adopt', DSH_DEFAULT)
    await bridge.attach(agent, { mode: 'attach', sessionDir: await sessionDir(), cwd: '/work' })
    expect(writes(requests)).toEqual([])
    expect(requests.map(request => request.type)).toEqual(expect.arrayContaining(['get_state', 'get_available_models']))
    expect(badge(session)).toEqual({ provider: 'cpa', model: 'claude-opus-4-6', reasoningEffort: 'high' })
  })

  it('ignores an ambient selection when the session already carries history', async () => {
    const reply = scriptedOmp({ state: { provider: 'cpa', id: 'claude-opus-4-6' }, models: [OPUS_4, GLM] })
    const { ctx, bridge, requests } = await mountedBridge(reply)
    const { agent, model } = await modelAgent(ctx, 'omp-model-history')
    model.select(DSH_DEFAULT)
    await bridge.attach(agent, { mode: 'attach', sessionDir: await sessionDir(), cwd: '/work', selection: DSH_DEFAULT })
    expect(writes(requests)).toEqual([])
  })

  it('sends one model frame when minting a blank session with an explicit pick', async () => {
    const reply = scriptedOmp({ state: { provider: 'cpa', id: 'claude-opus-4-6' }, models: [OPUS_4, OPUS_5] })
    const { ctx, bridge, requests } = await mountedBridge(reply)
    const { agent, session } = await modelAgent(ctx, 'omp-model-mint', DSH_DEFAULT)
    await bridge.attach(agent, {
      mode: 'attach',
      sessionDir: await sessionDir(),
      cwd: '/work',
      selection: { provider: 'cpa', model: 'claude-opus-5' },
    })
    expect(requests.filter(request => request.type === 'set_model')).toMatchObject([{ provider: 'cpa', modelId: 'claude-opus-5' }])
    expect(badge(session)).toEqual({ provider: 'cpa', model: 'claude-opus-5' })
  })

  it('forwards an operator selection as both calls and falls back to the process state when the effort is rejected', async () => {
    const reply = scriptedOmp({
      state: { provider: 'cpa', id: 'claude-opus-4-6', thinkingLevel: 'low' },
      models: [OPUS_4, OPUS_5],
      reject: ['set_thinking_level'],
    })
    const { ctx, bridge, requests } = await mountedBridge(reply)
    const { agent, session, model } = await modelAgent(ctx, 'omp-model-reject', { provider: 'cpa', model: 'claude-opus-4-6' })
    await bridge.attach(agent, { mode: 'attach', sessionDir: await sessionDir(), cwd: '/work' })
    model.select({ provider: 'cpa', model: 'claude-opus-5', reasoningEffort: 'high' } as ModelSelection)
    await waitFor(() => session.snapshotEvents().some(event => event.type === 'command/done'))
    expect(requests.filter(request => request.type === 'set_model')).toMatchObject([{ provider: 'cpa', modelId: 'claude-opus-5' }])
    expect(requests.filter(request => request.type === 'set_thinking_level')).toMatchObject([{ level: 'high' }])
    expect(badge(session)).toEqual({ provider: 'cpa', model: 'claude-opus-5', reasoningEffort: 'low' })
    expect(session.snapshotEvents().find(event => event.type === 'command/done'))
      .toMatchObject({ data: { kind: 'error' } })
  })

  it('follows a model the OMP process switched to on its own', async () => {
    const state = { provider: 'cpa', id: 'claude-opus-4-6', thinkingLevel: 'low' }
    const reply = scriptedOmp({ state, models: [OPUS_4, OPUS_5] })
    const { ctx, bridge, requests, send } = await mountedBridge(reply)
    const { agent, session } = await modelAgent(ctx, 'omp-model-switch', DSH_DEFAULT)
    await bridge.attach(agent, { mode: 'attach', sessionDir: await sessionDir(), cwd: '/work' })
    state.provider = 'cpa'
    state.id = 'claude-opus-5'
    send({ type: 'model_changed' })
    await waitFor(() => (badge(session) as { model?: string } | undefined)?.model === 'claude-opus-5')
    expect(writes(requests)).toEqual([])
  })
})
