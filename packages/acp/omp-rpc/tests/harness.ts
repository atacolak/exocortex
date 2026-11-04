import { createServer, type Server, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { OmpRpcClient } from '../src/client.ts'

/** One in-memory OMP RPC endpoint plus the frames each direction carried. */
export interface RpcHarness {
  readonly client: OmpRpcClient
  /** Frames the client wrote toward the OMP process. */
  readonly written: string[]
  /** Push one frame from the OMP process toward the client. */
  readonly receive: (frame: unknown) => void
  /** Close the OMP-to-client stream, as process exit does. */
  readonly end: () => void
}

function splitLines(onLine: (line: string) => void): (chunk: string) => void {
  let buffered = ''
  return (chunk) => {
    buffered += chunk
    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      onLine(buffered.slice(0, newline))
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
    }
  }
}

/** Build one in-memory RPC endpoint. */
export function rpcHarness(): RpcHarness {
  const inbound = new PassThrough()
  const outbound = new PassThrough()
  const written: string[] = []
  outbound.setEncoding('utf8')
  outbound.on('data', splitLines((line) => { written.push(line) }))
  return {
    client: new OmpRpcClient({ input: inbound, output: outbound }),
    written,
    receive: (frame) => { inbound.write(`${JSON.stringify(frame)}\n`) },
    end: () => { inbound.end() },
  }
}

/** Yield to the event loop so stream writes settle. */
export function tick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>()
  setImmediate(() => { resolve(undefined) })
  return promise.then(() => {})
}

/** Parse one written frame, failing loudly when the client wrote nothing. */
export function frameAt(written: readonly string[], index: number): Record<string, unknown> {
  const line = written[index]
  if (line === undefined) throw new Error(`no frame written at index ${index}`)
  return JSON.parse(line) as Record<string, unknown>
}

/** One fake OMP session socket server answering protocol-v1 requests. */
export interface FakeSessionServer {
  readonly server: Server
  /** Connections accepted since the server started. */
  readonly connections: number
  /** Sockets currently attached. */
  readonly open: number
  /** Stop listening and destroy every client. */
  readonly close: () => Promise<void>
}

/**
 * Serve one OMP session socket the way a live TUI process does.
 * @param socketPath - published endpoint to listen on.
 * @param reply - per-frame response data; undefined answers with an empty body.
 * @returns the listening server and its connection counters.
 */
export async function fakeSessionServer(
  socketPath: string,
  reply: (frame: Record<string, unknown>) => unknown = () => ({}),
): Promise<FakeSessionServer> {
  let connections = 0
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    connections += 1
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
    socket.on('error', () => {})
    socket.setEncoding('utf8')
    socket.write(`${JSON.stringify({
      type: 'ready',
      protocolVersion: 1,
      supportedProtocolVersions: [1],
      maxFrameBytes: 1024 * 1024,
    })}\n`)
    let buffered = ''
    socket.on('data', (chunk: string) => {
      buffered += chunk
      let newline = buffered.indexOf('\n')
      while (newline !== -1) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        const frame = JSON.parse(line) as Record<string, unknown>
        const data = reply(frame)
        const response = { type: 'response', id: frame.id, command: frame.type, success: true }
        socket.write(`${JSON.stringify(data === undefined ? response : { ...response, data })}\n`)
        newline = buffered.indexOf('\n')
      }
    })
  })
  const listening = Promise.withResolvers<undefined>()
  server.once('error', listening.reject)
  server.listen(socketPath, () => { listening.resolve(undefined) })
  await listening.promise
  return {
    server,
    get connections() { return connections },
    get open() { return sockets.size },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      const closed = Promise.withResolvers<undefined>()
      server.close(() => { closed.resolve(undefined) })
      await closed.promise
    },
  }
}
