import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { OmpBridge } from '../src/bridge.ts'
import { launchOmpDaemon } from '../src/daemon.ts'
import { hydrateOmpSession } from '../src/resume.ts'
import { ompProcessAlive, probeOmpSocketSession } from '../src/socket.ts'

const FIXTURE = join(import.meta.dirname, 'fixtures', 'fake-omp.mjs')

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function sandbox(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omp-daemon-'))
  roots.push(root)
  return root
}

async function missing(path: string): Promise<boolean> {
  return await readFile(path).then(() => false, () => true)
}

function publishedPid(record: unknown): number {
  const pid = typeof record === 'object' && record !== null && 'pid' in record ? record.pid : undefined
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('publication recorded no pid')
  return pid
}

async function scopedAgent(ctx: Context, id: string): Promise<Agent> {
  const session = Session.create(SessionId(id))
  const agent = {
    id: session.id,
    session,
    model: { current: () => undefined },
    projectExternalWake: () => {},
    followup: () => {},
  } as unknown as Agent
  const scope = createScope(ctx, agent)
  ;(agent as unknown as { ctx: Context }).ctx = scope.ctx
  return agent
}

describe('detached OMP session daemon', () => {
  it('keeps OMP alive across a mid-turn bridge reload and hydrates the finished turn once', async () => {
    const root = await sandbox()
    const publicationDir = join(root, '.omp', 'run')
    const runDirectory = join(root, 'omp-run')
    const markers = join(root, 'markers')
    const transcriptPath = join(root, 'session.jsonl')
    const sessionId = 'omp-detached-session'
    vi.stubEnv('OMP_TEST_PUBLICATION_DIR', publicationDir)
    vi.stubEnv('OMP_TEST_TRANSCRIPT', transcriptPath)
    vi.stubEnv('OMP_TEST_MARKERS', markers)
    vi.stubEnv('OMP_TEST_SESSION_ID', sessionId)
    vi.stubEnv('OMP_TEST_TOOL_DELAY_MS', '1500')

    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    ctx.provide('tools', { definitions: () => [] } as never)
    const subprocess = {
      resolveExecutable: (command: string) => Promise.resolve(command),
      spawn: () => { throw new Error('a detached launch must not spawn through the subprocess provider') },
    } as unknown as SubprocessRuntime
    ctx.provide('subprocess', subprocess)
    let bridgeCtx!: Context
    await ctx.plugin(Object.assign((inner: Context) => { bridgeCtx = inner }, {
      inject: ['commands', 'subprocess', 'tools'],
    }))
    const bridge = new OmpBridge({
      ctx: bridgeCtx,
      subprocess,
      executable: FIXTURE,
      publicationDir,
      runDirectory,
      daemonIdleTimeoutMs: 60_000,
    })
    const agent = await scopedAgent(ctx, 'harness-detached')
    const attachment = await bridge.attach(agent, { mode: 'attach', sessionDir: join(root, 'sessions'), cwd: root })
    expect(attachment.launched).toBeUndefined()
    expect(attachment.session).toMatchObject({ id: sessionId, streaming: false })

    const pid = publishedPid(JSON.parse(await readFile(join(publicationDir, `${sessionId}.json`), 'utf8')))
    onTestFinished(() => { try { process.kill(pid, 'SIGTERM') } catch {} })
    expect(ompProcessAlive(pid)).toBe(true)
    expect((await lstat(join(runDirectory, `${sessionId}.sock`))).isSymbolicLink()).toBe(true)
    expect(await probeOmpSocketSession(runDirectory, sessionId)).toMatchObject({ kind: 'live', session: { pid } })

    const request: GenerateOptions = {
      provider: 'fake',
      model: 'fake',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'run the slow tool' }], source: { kind: 'user' } })],
    }
    const driver = bridge.driverOf(agent.id)
    if (driver === undefined) throw new Error('the bridge attached no driver')
    const running = (async () => {
      for await (const chunk of driver.stream(request, new AbortController().signal)) void chunk
    })()
    await vi.waitFor(async () => { await readFile(join(markers, 'tool-started')) }, { timeout: 10_000 })
    expect(bridge.attachedSession(agent.id)?.streaming).toBe(true)

    await bridge.dispose()
    await running
    expect(ompProcessAlive(pid)).toBe(true)
    expect(await probeOmpSocketSession(runDirectory, sessionId)).toMatchObject({ kind: 'live' })
    expect(await missing(join(markers, 'stdin-ended'))).toBe(true)

    const reattached = new OmpBridge({
      ctx: bridgeCtx,
      subprocess,
      executable: FIXTURE,
      publicationDir,
      runDirectory,
      daemonIdleTimeoutMs: 60_000,
    })
    onTestFinished(() => reattached.dispose())
    const adopted = await reattached.attach(agent, {
      mode: 'attach',
      sessionId,
      sessionDir: join(root, 'sessions'),
      cwd: root,
      socketPath: join(runDirectory, `${sessionId}.sock`),
      managedStreams: true,
    })
    expect(adopted.launched).toBeUndefined()
    expect(adopted.session).toMatchObject({ id: sessionId, streaming: true })

    await vi.waitFor(async () => { await readFile(join(markers, 'turn-finished')) }, { timeout: 10_000 })
    const adoptedDriver = reattached.driverOf(agent.id)
    if (adoptedDriver === undefined) throw new Error('the reattached bridge attached no driver')
    const drained: StreamChunk[] = []
    for await (const chunk of adoptedDriver.stream({ ...request, messages: [] }, new AbortController().signal)) {
      drained.push(chunk)
    }
    expect(drained.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(reattached.attachedSession(agent.id)?.streaming).toBe(false)
    expect(await missing(join(markers, 'prompt-2'))).toBe(true)

    const hydrated = Session.create(SessionId('harness-hydrated'))
    const first = await hydrateOmpSession(hydrated, transcriptPath)
    expect(first.turns).toBe(1)
    const events = hydrated.snapshotEvents()
    const count = (type: string): number => events.filter(event => event.type === type).length
    expect(count('user/message')).toBe(1)
    expect(count('tool/call')).toBe(1)
    expect(count('tool/result')).toBe(1)
    const calls = events.flatMap(event => event.type === 'tool/call' ? [event.data.callId] : [])
    const results = events.flatMap(event => event.type === 'tool/result' ? [event.data.message.toolCallId] : [])
    expect(calls).toEqual(['call-slow'])
    expect(results).toEqual(calls)
    const again = await hydrateOmpSession(hydrated, transcriptPath, Number.POSITIVE_INFINITY, first)
    expect(again.appended).toBe(0)
    expect(hydrated.snapshotEvents()).toHaveLength(events.length)
    expect(await missing(join(markers, 'stdin-ended'))).toBe(true)
  })

  it('mirrors the publication into the run directory and ends stdin only after the idle timeout', async () => {
    const root = await sandbox()
    const publicationDir = join(root, '.omp', 'run')
    const runDirectory = join(root, 'omp-run')
    const markers = join(root, 'markers')
    const transcriptPath = join(root, 'session.jsonl')
    const sessionId = 'omp-idle-session'
    const handshakePath = join(root, 'handshake.json')
    vi.stubEnv('OMP_TEST_PUBLICATION_DIR', publicationDir)
    vi.stubEnv('OMP_TEST_TRANSCRIPT', transcriptPath)
    vi.stubEnv('OMP_TEST_MARKERS', markers)
    vi.stubEnv('OMP_TEST_SESSION_ID', sessionId)

    const launch = launchOmpDaemon({
      argv: [FIXTURE, '--mode', 'rpc', '--session-dir', join(root, 'sessions')],
      cwd: root,
      publicationDir,
      runDirectory,
      handshakePath,
      idleTimeoutMs: 250,
      publicationTimeoutMs: 10_000,
    })
    const published = await launch.published
    expect(published).toEqual({
      ompSessionId: sessionId,
      pid: expect.any(Number) as number,
      socketPath: join(runDirectory, `${sessionId}.sock`),
    })
    expect(published.pid).toBe(publishedPid(JSON.parse(await readFile(join(publicationDir, `${sessionId}.json`), 'utf8'))))
    expect((await lstat(join(runDirectory, `${sessionId}.json`))).isSymbolicLink()).toBe(true)
    expect((await lstat(join(runDirectory, `${sessionId}.sock`))).isSymbolicLink()).toBe(true)
    expect(await missing(join(markers, 'stdin-ended'))).toBe(true)

    await launch.dispose()
    expect(await missing(handshakePath)).toBe(true)
    await vi.waitFor(async () => {
      expect(await missing(join(markers, 'stdin-ended'))).toBe(false)
    }, { timeout: 10_000 })
    await vi.waitFor(async () => {
      expect(await missing(join(runDirectory, `${sessionId}.sock`))).toBe(true)
      expect(await missing(join(runDirectory, `${sessionId}.json`))).toBe(true)
    }, { timeout: 10_000 })
    await vi.waitFor(() => { expect(ompProcessAlive(published.pid)).toBe(false) }, { timeout: 10_000 })
  })
})
