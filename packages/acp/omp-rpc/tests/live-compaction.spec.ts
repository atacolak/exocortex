import { spawn } from 'node:child_process'
import { appendFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { bindingFactsOf, OmpBindings, rememberOmpBinding } from '../src/bindings.ts'
import { OmpBridge } from '../src/bridge.ts'
import { openOmpTranscript, planOmpWake } from '../src/open.ts'
import { hydrateOmpSession, type OmpHydrationCursor, type OmpHydrationOutcome } from '../src/resume.ts'
import {
  clearOmpSessionArtifacts,
  ompSocketPath,
  probeOmpSocketSession,
} from '../src/socket.ts'
import { fakeSessionServer, tick, type FakeSessionServer } from './harness.ts'

const EPOCH = Date.parse('2026-11-05T00:00:00.000Z')

const OMP_SESSION = '01a1722b-3e29-7000-b9d5-b05807bbe4b8'

function entryId(n: number): string {
  return n.toString(16).padStart(8, '0')
}

function stamp(turn: number, offsetSeconds = 0): string {
  return new Date(EPOCH + turn * 60_000 + offsetSeconds * 1_000).toISOString()
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
    timestamp: stamp(turn, 1),
    message: { role: 'assistant', content: [{ type: 'text', text: `answer ${String(turn)}` }] },
  }
}

function compactionLine(request: {
  readonly id: number
  readonly parent: string
  readonly turn: number
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly method: string
}): unknown {
  return {
    type: 'compaction',
    id: entryId(request.id),
    parentId: request.parent,
    timestamp: stamp(request.turn, 30),
    summary: `archived context ${String(request.id)}`,
    shortSummary: 'archived',
    firstKeptEntryId: entryId(1),
    tokensBefore: request.tokensBefore,
    tokensAfter: request.tokensAfter,
    method: request.method,
  }
}

async function appendLine(path: string, line: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(line)}\n`)
}

async function transcriptOf(lines: readonly unknown[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'omp-live-transcript-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'transcript.jsonl')
  await writeFile(path, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)
  return path
}

function cursorOf(outcome: OmpHydrationOutcome): OmpHydrationCursor {
  return {
    hydratedTurns: outcome.hydratedTurns,
    ...outcome.hydratedLeafEntryId === undefined ? {} : { hydratedLeafEntryId: outcome.hydratedLeafEntryId },
    ...outcome.hydratedByteOffset === undefined ? {} : { hydratedByteOffset: outcome.hydratedByteOffset },
  }
}

interface BridgeFixture {
  readonly ctx: Context
  readonly bridge: OmpBridge
  readonly cursors: { entryId: string; byteOffset: number }[]
  readonly forgotten: unknown[]
}

async function socketBridge(): Promise<BridgeFixture> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  ctx.provide('tools', { definitions: () => [] } as never)
  const subprocess = {
    resolveExecutable: async (command: string) => command,
    spawn: () => { throw new Error('a live socket attach must not launch OMP') },
  }
  ctx.provide('subprocess', subprocess as never)
  let bridgeCtx!: Context
  await ctx.plugin(Object.assign((inner: Context) => { bridgeCtx = inner }, {
    inject: ['commands', 'subprocess', 'tools'],
  }))
  const cursors: { entryId: string; byteOffset: number }[] = []
  const forgotten: unknown[] = []
  const bridge = new OmpBridge({
    ctx: bridgeCtx,
    subprocess: subprocess as never,
    executable: 'omp',
    onCompactionCursor: (_sessionId, cursor) => { cursors.push(cursor) },
  })
  onTestFinished(() => bridge.dispose())
  return { ctx, bridge, cursors, forgotten }
}

async function scopedAgent(ctx: Context, id: string): Promise<{ agent: Agent; bridgeCtx: Context }> {
  const session = Session.create(SessionId(id))
  const agent = { id: session.id, session, model: { current: () => undefined } } as unknown as Agent
  const scope = createScope(ctx, agent)
  ;(agent as unknown as { ctx: Context }).ctx = scope.ctx
  return { agent, bridgeCtx: scope.ctx }
}

const servers = new Set<FakeSessionServer>()
const directories = new Set<string>()

afterEach(async () => {
  for (const server of servers) await server.close()
  servers.clear()
  for (const directory of directories) await rm(directory, { recursive: true, force: true })
  directories.clear()
})

async function published(request: {
  readonly ompSessionId: string
  readonly transcriptPath: string
  readonly pid?: number
  readonly reply?: (frame: Record<string, unknown>) => unknown
}): Promise<{ directory: string; server: FakeSessionServer; frames: Record<string, unknown>[] }> {
  const directory = await mkdtemp(join(tmpdir(), 'omp-live-run-'))
  directories.add(directory)
  const frames: Record<string, unknown>[] = []
  const server = await fakeSessionServer(ompSocketPath(directory, request.ompSessionId), (frame) => {
    frames.push(frame)
    const custom = request.reply?.(frame)
    if (custom !== undefined) return custom
    if (frame.type === 'get_state') {
      return { sessionId: request.ompSessionId, sessionFile: request.transcriptPath, cwd: '/work' }
    }
    if (frame.type === 'get_available_models') return { models: [] }
    if (frame.type === 'get_available_commands') return { commands: [] }
    return {}
  })
  servers.add(server)
  await writeFile(join(directory, `${request.ompSessionId}.json`), JSON.stringify({
    pid: request.pid ?? process.pid,
    sessionId: request.ompSessionId,
    sessionFile: request.transcriptPath,
    cwd: '/work',
    startedAt: Date.now(),
  }))
  return { directory, server, frames }
}


async function launchingBridge(transcriptPath: string): Promise<{
  bridge: OmpBridge
  argv: string[][]
  ctx: Context
}> {
  const argv: string[][] = []
  const subprocess = {
    resolveExecutable: async (command: string) => command,
    spawn: (request: { readonly argv: readonly string[] }): SubprocessHandle => {
      argv.push([...request.argv])
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
          const frame = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>
          buffered = buffered.slice(newline + 1)
          const data = frame.type === 'get_state'
            ? { sessionId: 'omp-woken', sessionFile: transcriptPath, isStreaming: false }
            : []
          stdout.write(`${JSON.stringify({
            type: 'response',
            id: frame.id,
            command: frame.type,
            success: true,
            data,
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

  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  ctx.provide('tools', { definitions: () => [] } as never)
  ctx.provide('subprocess', subprocess as never)
  let bridgeCtx!: Context
  await ctx.plugin(Object.assign((inner: Context) => { bridgeCtx = inner }, {
    inject: ['commands', 'subprocess', 'tools'],
  }))
  const bridge = new OmpBridge({ ctx: bridgeCtx, subprocess, executable: 'omp' })
  onTestFinished(() => bridge.dispose())
  return { bridge, argv, ctx }
}

function summaries(session: Session): SessionEvent<'compaction/summary'>[] {
  return session.snapshotEvents().filter(
    (event): event is SessionEvent<'compaction/summary'> => event.type === 'compaction/summary',
  )
}

describe('live OMP compaction projection', () => {
  it('projects a threshold pass into one card and never repeats it', async () => {
    const transcriptPath = await transcriptOf([
      sessionLine(),
      userEntry(1, OMP_SESSION),
      assistantEntry(1),
    ])
    const fixture = await socketBridge()
    const { directory, server } = await published({ ompSessionId: 'omp-live-auto', transcriptPath })
    const { agent } = await scopedAgent(fixture.ctx, 'live-auto')
    await hydrateOmpSession(agent.session, transcriptPath)

    await fixture.bridge.attach(agent, {
      mode: 'attach',
      sessionDir: directory,
      socketPath: ompSocketPath(directory, 'omp-live-auto'),
      sessionId: 'omp-live-auto',
      cwd: '/work',
    })
    await tick()
    const boundary = compactionLine({ id: 101, parent: entryId(2), turn: 1, tokensBefore: 182_000, tokensAfter: 24_000, method: 'auto-threshold' })
    await appendLine(transcriptPath, boundary)
    server.broadcast({ type: 'auto_compaction_start', reason: 'context-threshold', action: 'summarize' })
    server.broadcast({ type: 'auto_compaction_end', aborted: false, skipped: false })

    await expect.poll(() => summaries(agent.session).length).toBe(1)
    const summary = summaries(agent.session)[0]!
    expect(summary.data.shadowedTokenCount).toBe(182_000)
    expect(summary.data.tokensAfter).toBe(24_000)
    expect(summary.data.method).toBe('auto-threshold')

    const checkpoint = agent.session.snapshotEvents().find(event =>
      event.type === 'user/message' && event.data.source.kind === 'compact-checkpoint')
    expect(checkpoint).toBeDefined()
    expect(agent.session.snapshotEvents()
      .filter(event => event.type === 'compaction/start' || event.type === 'compaction/end')
      .map(event => event.type)).toEqual(['compaction/start', 'compaction/end'])

    expect(fixture.cursors).toHaveLength(1)
    expect(fixture.cursors[0]).toEqual({ entryId: entryId(2), byteOffset: expect.any(Number) })

    const before = agent.session.snapshotEvents().length
    server.broadcast({ type: 'auto_compaction_end', aborted: false, skipped: false })
    await tick()
    expect(summaries(agent.session)).toHaveLength(1)
    expect(agent.session.snapshotEvents()).toHaveLength(before)

    const again = await hydrateOmpSession(agent.session, transcriptPath, Number.POSITIVE_INFINITY, {
      hydratedTurns: 0,
      ...fixture.cursors[0]!,
    })
    expect(again.appended).toBe(0)
    expect(summaries(agent.session)).toHaveLength(1)
    expect(agent.session.snapshotEvents()).toHaveLength(before)

    await fixture.bridge.detach(agent.id)
  })

  it('projects a manual /compact pass through the command result and the end frame once', async () => {
    const transcriptPath = await transcriptOf([
      sessionLine(),
      userEntry(1, OMP_SESSION),
      assistantEntry(1),
    ])
    const fixture = await socketBridge()
    let server: FakeSessionServer | undefined
    const publishedSession = await published({
      ompSessionId: 'omp-live-manual',
      transcriptPath,
      reply: (frame) => {
        if (frame.type !== 'compact') return undefined
        queueMicrotask(() => { server?.broadcast({ type: 'manual_compaction_end', aborted: false, skipped: false }) })
        return { tokensBefore: 90_000 }
      },
    })
    server = publishedSession.server
    const { agent } = await scopedAgent(fixture.ctx, 'live-manual')
    await fixture.bridge.attach(agent, {
      mode: 'attach',
      sessionDir: publishedSession.directory,
      socketPath: ompSocketPath(publishedSession.directory, 'omp-live-manual'),
      sessionId: 'omp-live-manual',
      cwd: '/work',
    })
    await tick()
    await hydrateOmpSession(agent.session, transcriptPath)
    await appendLine(transcriptPath, compactionLine({
      id: 101, parent: entryId(2), turn: 1, tokensBefore: 90_000, tokensAfter: 12_000, method: 'manual',
    }))

    const signal = new AbortController().signal
    const result = await fixture.ctx.commands.execute(agent, '/compact', [], signal)
    expect(result?.result).toEqual({ kind: 'success', text: 'Compacted OMP context (90000 tokens before).' })
    await expect.poll(() => summaries(agent.session).length).toBe(1)
    expect(summaries(agent.session)[0]!.data.method).toBe('manual')
    expect(summaries(agent.session)[0]!.data.tokensAfter).toBe(12_000)
    await tick()
    expect(summaries(agent.session)).toHaveLength(1)

    await fixture.bridge.detach(agent.id)
  })

  it('projects a manual command identity into the checkpoint source', async () => {
    const transcriptPath = await transcriptOf([
      sessionLine(),
      userEntry(1, OMP_SESSION),
      assistantEntry(1),
    ])
    const fixture = await socketBridge()
    const { directory } = await published({ ompSessionId: 'omp-live-id', transcriptPath })
    const { agent } = await scopedAgent(fixture.ctx, 'live-id')
    await fixture.bridge.attach(agent, {
      mode: 'attach',
      sessionDir: directory,
      socketPath: ompSocketPath(directory, 'omp-live-id'),
      sessionId: 'omp-live-id',
      cwd: '/work',
    })
    await tick()
    await hydrateOmpSession(agent.session, transcriptPath)
    await appendLine(transcriptPath, compactionLine({
      id: 101, parent: entryId(2), turn: 1, tokensBefore: 50_000, tokensAfter: 9_000, method: 'manual',
    }))

    await fixture.bridge.compact(agent.id, '', 'command-manual-1' as CommandId)
    await expect.poll(() => summaries(agent.session).length).toBe(1)
    const checkpoint = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.source.kind === 'compact-checkpoint')
    if (checkpoint?.type !== 'user/message' || checkpoint.data.source.kind !== 'compact-checkpoint') {
      throw new Error('the manual compaction projected no checkpoint')
    }
    expect(checkpoint.data.source.sourceCommandId).toBe('command-manual-1')

    await fixture.bridge.detach(agent.id)
  })
})

describe('idle OMP unload', () => {
  it('drops the attachment without an error, tail-syncs the idle compaction, and wakes the transcript on the next attach', async () => {
    const transcriptPath = await transcriptOf([
      sessionLine(),
      userEntry(1, OMP_SESSION),
      assistantEntry(1),
    ])
    const fixture = await socketBridge()
    const { directory, server } = await published({ ompSessionId: 'omp-live-idle', transcriptPath })
    const { agent } = await scopedAgent(fixture.ctx, 'live-idle')
    agent.forgetOmpDriver = (driver) => { fixture.forgotten.push(driver) }
    const first = await hydrateOmpSession(agent.session, transcriptPath)
    const attachment = await fixture.bridge.attach(agent, {
      mode: 'attach',
      sessionDir: directory,
      socketPath: ompSocketPath(directory, 'omp-live-idle'),
      sessionId: 'omp-live-idle',
      cwd: '/work',
    })
    await tick()
    const eventsBefore = agent.session.snapshotEvents().length

    await server.close()
    await expect.poll(() => fixture.bridge.attached(agent.id), { timeout: 5_000 }).toBe(false)

    expect(attachment.client.closed).toBe(true)
    expect(fixture.forgotten).toEqual([expect.anything()])
    expect(agent.session.snapshotEvents()).toHaveLength(eventsBefore)

    await appendLine(transcriptPath, compactionLine({
      id: 101, parent: entryId(2), turn: 1, tokensBefore: 120_000, tokensAfter: 18_000, method: 'idle-maintenance',
    }))
    const woke = await hydrateOmpSession(agent.session, transcriptPath, Number.POSITIVE_INFINITY, cursorOf(first))
    expect(woke.appended).toBeGreaterThan(0)
    expect(summaries(agent.session).map(event => event.data.method)).toEqual(['idle-maintenance'])
    const settled = await hydrateOmpSession(agent.session, transcriptPath, Number.POSITIVE_INFINITY, cursorOf(woke))
    expect(settled.appended).toBe(0)
    expect(summaries(agent.session)).toHaveLength(1)

    const wake = await launchingBridge(transcriptPath)
    const resumed = await wake.bridge.attach(agent, {
      mode: 'attach',
      sessionDir: directory,
      resumePath: transcriptPath,
      cwd: '/work',
    })
    expect(resumed.session.path).toBe(transcriptPath)
    expect(wake.argv.at(-1)).toEqual(expect.arrayContaining(['--resume', transcriptPath]))
    await wake.bridge.detach(agent.id)
  })
})

describe('stale OMP publication cleanup', () => {
  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    const exited = Promise.withResolvers<number>()
    child.once('exit', () => { exited.resolve(child.pid ?? 0) })
    return await exited.promise
  }

  it('collects the sidecar, socket, and bind lock of a killed process before resuming', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'omp-stale-run-'))
    directories.add(directory)
    const sessionId = 'omp-stale-1'
    const sidecar = join(directory, `${sessionId}.json`)
    await writeFile(sidecar, JSON.stringify({ pid: await deadPid(), sessionId, cwd: '/work', sessionFile: '/t.jsonl' }))
    await writeFile(ompSocketPath(directory, sessionId), 'stale')
    await writeFile(join(directory, `${sessionId}.sock.bind.lock`), 'stale')

    const state = await probeOmpSocketSession(directory, sessionId)
    expect(state.kind).toBe('stale')
    if (state.kind !== 'stale') throw new Error('expected a stale publication')
    expect(planOmpWake(state).kind).toBe('resume')

    await clearOmpSessionArtifacts(directory, sessionId)
    await expect(readFile(sidecar)).rejects.toThrow()
    await expect(readFile(ompSocketPath(directory, sessionId))).rejects.toThrow()
    await expect(readFile(join(directory, `${sessionId}.sock.bind.lock`))).rejects.toThrow()
    expect(await probeOmpSocketSession(directory, sessionId)).toEqual({ kind: 'absent' })
  })

  it('resumes a transcript whose sidecar is gone even when a socket file lingers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'omp-absent-run-'))
    directories.add(directory)
    const sessionId = 'omp-absent-1'
    await writeFile(ompSocketPath(directory, sessionId), 'transient')

    const state = await probeOmpSocketSession(directory, sessionId)
    expect(state).toEqual({ kind: 'absent' })
    expect(planOmpWake(state).kind).toBe('resume')
    expect(await readFile(ompSocketPath(directory, sessionId), 'utf8')).toBe('transient')
  })

  it('reports a live pid that will not answer as hung and leaves its publication alone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'omp-hung-run-'))
    directories.add(directory)
    const sessionId = 'omp-hung-1'
    await writeFile(join(directory, `${sessionId}.json`), JSON.stringify({
      pid: process.pid, sessionId, cwd: '/work', sessionFile: '/t.jsonl',
    }))
    await writeFile(ompSocketPath(directory, sessionId), 'not-a-socket')
    await writeFile(join(directory, `${sessionId}.sock.bind.lock`), 'locked')

    const state = await probeOmpSocketSession(directory, sessionId)
    expect(state.kind).toBe('hung')
    const plan = planOmpWake(state)
    expect(plan.kind).toBe('hung')
    await expect(readFile(join(directory, `${sessionId}.json`))).resolves.toBeDefined()
    await expect(readFile(ompSocketPath(directory, sessionId), 'utf8')).resolves.toBe('not-a-socket')
    await expect(readFile(join(directory, `${sessionId}.sock.bind.lock`), 'utf8')).resolves.toBe('locked')
  })

  it('attaches a symlinked socket path the run directory published', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'omp-link-run-'))
    directories.add(directory)
    const sessionId = 'omp-linked-1'
    const real = join(directory, 'real.sock')
    const server = await fakeSessionServer(real, (frame) => {
      if (frame.type === 'get_state') return { sessionId, cwd: '/work' }
      if (frame.type === 'get_available_models') return { models: [] }
      if (frame.type === 'get_available_commands') return { commands: [] }
      return {}
    })
    servers.add(server)
    await symlink(real, ompSocketPath(directory, sessionId))
    await writeFile(join(directory, `${sessionId}.json`), JSON.stringify({
      pid: process.pid, sessionId, cwd: '/work', sessionFile: '/t.jsonl',
    }))

    const state = await probeOmpSocketSession(directory, sessionId)
    expect(state.kind).toBe('live')
    expect(planOmpWake(state).kind).toBe('attach')
  })
})

describe('binding preservation', () => {
  it('keeps the transcript path and hydration cursor when an attachment reports none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omp-binding-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const bindings = new OmpBindings(join(root, 'bindings.json'))
    const id = SessionId('bind-preserve')
    await bindings.set(id, {
      ompSessionId: 'omp-bind',
      path: '/transcripts/omp-bind.jsonl',
      cwd: '/work',
      hydratedTurns: 12,
      hydratedLeafEntryId: 'leaf-12',
      hydratedByteOffset: 4096,
      updatedAt: '2026-11-04T00:00:00.000Z',
    })

    expect(bindingFactsOf({ ompSessionId: 'omp-bind', path: undefined, cwd: '/work' })).toBeUndefined()
    expect(await rememberOmpBinding({
      bindings,
      id,
      facts: bindingFactsOf({ ompSessionId: 'omp-bind', path: undefined, cwd: '/work' }),
    })).toBeUndefined()

    expect(await bindings.get(id)).toMatchObject({
      path: '/transcripts/omp-bind.jsonl',
      hydratedTurns: 12,
      hydratedLeafEntryId: 'leaf-12',
      hydratedByteOffset: 4096,
    })
  })

  it('keeps the cursor when a resumed attachment reports the same transcript again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omp-binding-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const bindings = new OmpBindings(join(root, 'bindings.json'))
    const id = SessionId('bind-merge')
    await bindings.set(id, {
      ompSessionId: 'omp-merge',
      path: '/transcripts/omp-merge.jsonl',
      cwd: '/work',
      hydratedTurns: 7,
      hydratedLeafEntryId: 'leaf-7',
      hydratedByteOffset: 2048,
      updatedAt: '2026-11-04T00:00:00.000Z',
    })
    await rememberOmpBinding({
      bindings,
      id,
      facts: bindingFactsOf({ ompSessionId: 'omp-merge', path: '/transcripts/omp-merge.jsonl', cwd: '/work' }),
    })
    expect(await bindings.get(id)).toMatchObject({
      hydratedTurns: 7,
      hydratedLeafEntryId: 'leaf-7',
      hydratedByteOffset: 2048,
    })
  })
})

describe('repeated transcript opens', () => {
  it('reuses the attachment already serving the transcript instead of attaching again', async () => {
    const fixture = await socketBridge()
    const transcriptPath = await transcriptOf([sessionLine(), userEntry(1, OMP_SESSION), assistantEntry(1)])
    const { directory } = await published({ ompSessionId: 'omp-open-once', transcriptPath })
    const { agent } = await scopedAgent(fixture.ctx, 'open-once')
    await fixture.bridge.attach(agent, {
      mode: 'attach',
      sessionDir: directory,
      socketPath: ompSocketPath(directory, 'omp-open-once'),
      sessionId: 'omp-open-once',
      cwd: '/work',
    })
    await tick()

    let attaches = 0
    let hydrations = 0
    const opened = await openOmpTranscript({
      ompSessionId: 'omp-open-once',
      attached: fixture.bridge.attachedSession(agent.id),
      attach: async () => { attaches += 1 },
      hydrate: async () => { hydrations += 1; return 0 },
    })
    expect(opened).toEqual({ hydrated: 0, reused: true })
    expect(attaches).toBe(0)
    expect(hydrations).toBe(1)

    await fixture.bridge.detach(agent.id)
  })

  it('attaches when the session serves a different OMP session', async () => {
    let attaches = 0
    const opened = await openOmpTranscript({
      ompSessionId: 'omp-wanted',
      attached: { id: 'omp-other' },
      attach: async () => { attaches += 1 },
      hydrate: async () => 3,
    })
    expect(opened).toEqual({ hydrated: 3, reused: false })
    expect(attaches).toBe(1)
  })
})
