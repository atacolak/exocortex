import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import {
  connectOmpSocket,
  ompRunDirectory,
  ompSocketPath,
  readOmpSocketSession,
  resolveOmpRunDirectory,
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

async function sessionsDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'omp-sessions-'))
  directories.add(directory)
  return directory
}

async function serve(
  directory: string,
  sessionId: string,
  options: { readonly pid?: number; readonly sessionFile?: string | null } = {},
): Promise<FakeSessionServer> {
  const socketPath = ompSocketPath(directory, sessionId)
  const server = await fakeSessionServer(socketPath, (frame) => {
    if (frame.type === 'get_state') return { sessionId }
    return {}
  })
  servers.add(server)
  const sessionFile = options.sessionFile === undefined ? `/transcripts/${sessionId}.jsonl` : options.sessionFile
  await writeFile(join(directory, `${sessionId}.json`), JSON.stringify({
    pid: options.pid ?? process.pid,
    sessionId,
    ...sessionFile === null ? {} : { sessionFile },
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

  it('prefers an explicit run directory over OMP_RUN_DIR', () => {
    expect(resolveOmpRunDirectory('/explicit/run', '/home/x', { OMP_RUN_DIR: '/env/run' })).toBe('/explicit/run')
  })

  it('follows OMP_RUN_DIR when no run directory is configured', () => {
    expect(resolveOmpRunDirectory(undefined, '/home/x', { OMP_RUN_DIR: '/env/run' })).toBe('/env/run')
  })

  it('falls back to the OMP run root under the owning home', () => {
    expect(resolveOmpRunDirectory(undefined, '/home/x', {})).toBe(join('/home/x', '.omp', 'run'))
    expect(resolveOmpRunDirectory(undefined, undefined, {})).toBe(ompRunDirectory(homedir()))
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
    const root = await sessionsDirectory()
    await serve(directory, 'live', { sessionFile: join(root, 'live.jsonl') })
    await serve(directory, 'dead', { pid: 2_147_483_647, sessionFile: join(root, 'dead.jsonl') })
    expect((await scanOmpRunDirectory(directory, root)).map(session => session.sessionId)).toEqual(['live'])
  })

  it('ignores a missing run directory', async () => {
    expect(await scanOmpRunDirectory(join(tmpdir(), 'omp-run-missing', 'run'), join(tmpdir(), 'omp-sessions-missing'))).toEqual([])
  })
})

describe('OMP run directory ownership', () => {
  it('adopts a session whose transcript lives inside the sessions root', async () => {
    const directory = await runDirectory()
    const root = await sessionsDirectory()
    await serve(directory, 'owned', { sessionFile: join(root, 'owned.jsonl') })
    expect((await scanOmpRunDirectory(directory, root)).map(session => session.sessionId)).toEqual(['owned'])
  })

  it('skips a session whose transcript belongs to another instance', async () => {
    const directory = await runDirectory()
    const root = await sessionsDirectory()
    const foreignRoot = await sessionsDirectory()
    await serve(directory, 'foreign', { sessionFile: join(foreignRoot, 'foreign.jsonl') })
    expect(await scanOmpRunDirectory(directory, root)).toEqual([])
  })

  it('skips a sibling directory sharing the root name prefix', async () => {
    const directory = await runDirectory()
    const root = await sessionsDirectory()
    await serve(directory, 'sibling', { sessionFile: join(`${root}-mirror`, 'sibling.jsonl') })
    expect(await scanOmpRunDirectory(directory, root)).toEqual([])
  })

  it('adopts a session with no transcript path', async () => {
    const directory = await runDirectory()
    const root = await sessionsDirectory()
    await serve(directory, 'unbound', { sessionFile: null })
    expect((await scanOmpRunDirectory(directory, root)).map(session => session.sessionId)).toEqual(['unbound'])
  })

  it('resolves path traversal before comparing roots', async () => {
    const directory = await runDirectory()
    const root = await sessionsDirectory()
    await serve(directory, 'escaping', { sessionFile: join(root, '..', 'escape', 'session.jsonl') })
    expect(await scanOmpRunDirectory(directory, root)).toEqual([])
  })

  it('adopts a path that traverses back inside the root', async () => {
    const directory = await runDirectory()
    const root = await sessionsDirectory()
    await serve(directory, 'normalized', { sessionFile: join(root, 'nested', '..', 'session.jsonl') })
    expect((await scanOmpRunDirectory(directory, root)).map(session => session.sessionId)).toEqual(['normalized'])
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
      sessionsRoot: '/transcripts',
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
      sessionsRoot: '/transcripts',
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

  it('reports only the sessions owned by the given root', async () => {
    const directory = await runDirectory()
    const root = await sessionsDirectory()
    const foreignRoot = await sessionsDirectory()
    await serve(directory, 'owned', { sessionFile: join(root, 'owned.jsonl') })
    await serve(directory, 'foreign', { sessionFile: join(foreignRoot, 'foreign.jsonl') })
    const seen: string[] = []
    const stop = watchOmpRunDirectory({
      runDir: directory,
      sessionsRoot: root,
      intervalMs: 20,
      onSession: (session) => { seen.push(session.sessionId) },
    })
    onTestFinished(stop)
    await waitFor(() => seen.includes('owned'))
    expect(seen).toEqual(['owned'])
  })
})
