import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import {
  connectOmpSocket,
  ompRunDirectory,
  ompSocketPath,
  readOmpSocketSession,
  scanOmpRunDirectory,
  watchOmpRunDirectory,
} from '../src/socket.ts'
import { fakeSessionServer, tick, type FakeSessionServer } from './harness.ts'

const servers = new Set<FakeSessionServer>()
const directories = new Set<string>()

afterEach(async () => {
  for (const server of servers) await server.close()
  servers.clear()
  for (const directory of directories) await rm(directory, { recursive: true, force: true })
  directories.clear()
})

async function waitFor(condition: () => boolean): Promise<undefined> {
  const reached = Promise.withResolvers<undefined>()
  const timer = setInterval(() => {
    if (!condition()) return
    clearInterval(timer)
    reached.resolve(undefined)
  }, 10)
  try {
    await reached.promise
  } finally {
    clearInterval(timer)
  }
}

async function runDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'omp-run-'))
  directories.add(directory)
  return directory
}

async function serve(
  directory: string,
  sessionId: string,
  options: { readonly pid?: number; readonly socketFile?: string } = {},
): Promise<FakeSessionServer> {
  const socketPath = ompSocketPath(directory, sessionId)
  const server = await fakeSessionServer(socketPath, (frame) => {
    if (frame.type === 'get_state') return { sessionId }
    return {}
  })
  servers.add(server)
  await writeFile(join(directory, `${sessionId}.json`), JSON.stringify({
    pid: options.pid ?? process.pid,
    sessionId,
    sessionFile: options.socketFile ?? `/transcripts/${sessionId}.jsonl`,
    cwd: '/work',
    agent: 'test/model',
    startedAt: Date.now(),
  }))
  return server
}

describe('OMP run directory', () => {
  it('publishes one socket per run directory', () => {
    expect(ompRunDirectory('/home/x')).toBe(join('/home/x', '.omp', 'run'))
    expect(ompSocketPath('/run', 'abc')).toBe(join('/run', 'abc.sock'))
  })

  it('reads a live session sidecar', async () => {
    const directory = await runDirectory()
    await serve(directory, 'session-1')
    expect(await readOmpSocketSession(directory, 'session-1')).toMatchObject({
      sessionId: 'session-1',
      pid: process.pid,
      cwd: '/work',
      socketPath: ompSocketPath(directory, 'session-1'),
    })
  })

  it('rejects a sidecar whose pid is gone', async () => {
    const directory = await runDirectory()
    await serve(directory, 'session-gone', { pid: 2_147_483_647 })
    expect(await readOmpSocketSession(directory, 'session-gone')).toBeUndefined()
  })

  it('rejects a sidecar with no socket file', async () => {
    const directory = await runDirectory()
    await writeFile(join(directory, 'session-nosock.json'), JSON.stringify({
      pid: process.pid,
      sessionId: 'session-nosock',
      cwd: '/work',
    }))
    expect(await readOmpSocketSession(directory, 'session-nosock')).toBeUndefined()
  })

  it('scans only the attachable sessions', async () => {
    const directory = await runDirectory()
    await serve(directory, 'live')
    await serve(directory, 'dead', { pid: 2_147_483_647 })
    expect((await scanOmpRunDirectory(directory)).map(session => session.sessionId)).toEqual(['live'])
  })

  it('ignores a missing run directory', async () => {
    expect(await scanOmpRunDirectory(join(tmpdir(), 'omp-run-missing', 'run'))).toEqual([])
  })
})

describe('OMP session socket attachment', () => {
  it('receives the ready frame and detaches without stopping the owner', async () => {
    const directory = await runDirectory()
    const server = await serve(directory, 'session-1')
    const first = await connectOmpSocket(ompSocketPath(directory, 'session-1'))
    expect(first.client.protocol).toBe(1)
    first.close()
    await tick()
    const second = await connectOmpSocket(ompSocketPath(directory, 'session-1'))
    second.close()
    expect(server.connections).toBe(2)
  })

  it('fails loudly when nothing listens', async () => {
    const directory = await runDirectory()
    await expect(connectOmpSocket(ompSocketPath(directory, 'absent'), 200)).rejects.toThrow(/cannot attach OMP session socket/)
  })
})

describe('OMP run directory watcher', () => {
  it('reports sessions on the startup scan and stops cleanly', async () => {
    const directory = await runDirectory()
    await serve(directory, 'session-1')
    const seen: string[] = []
    const stop = watchOmpRunDirectory({
      runDir: directory,
      intervalMs: 20,
      onSession: (session) => { seen.push(session.sessionId) },
    })
    onTestFinished(stop)
    await waitFor(() => seen.includes('session-1'))
    expect(seen).toContain('session-1')
    const before = seen.length
    stop()
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(seen.length).toBe(before)
  })

  it('picks up a session that appears after startup', async () => {
    const directory = await runDirectory()
    const seen: string[] = []
    const stop = watchOmpRunDirectory({
      runDir: directory,
      intervalMs: 20,
      onSession: (session) => { seen.push(session.sessionId) },
    })
    onTestFinished(stop)
    await tick()
    expect(seen).toEqual([])
    await serve(directory, 'late')
    await waitFor(() => seen.includes('late'))
    expect(seen).toContain('late')
  })
})
