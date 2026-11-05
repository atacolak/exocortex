#!/usr/bin/env node
import { appendFileSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const publicationDir = process.env.OMP_TEST_PUBLICATION_DIR || process.env.OMP_RUN_DIR
  || join(process.env.HOME ?? homedir(), '.omp', 'run')
const transcriptPath = process.env.OMP_TEST_TRANSCRIPT
const markers = process.env.OMP_TEST_MARKERS
const sessionId = process.env.OMP_TEST_SESSION_ID ?? randomUUID()
const toolDelayMs = Number(process.env.OMP_TEST_TOOL_DELAY_MS ?? '600')
if (publicationDir === undefined || transcriptPath === undefined || markers === undefined) {
  throw new Error('fake omp needs OMP_TEST_PUBLICATION_DIR, OMP_TEST_TRANSCRIPT, and OMP_TEST_MARKERS')
}

const socketPath = join(publicationDir, `${sessionId}.sock`)
const sidecarPath = join(publicationDir, `${sessionId}.json`)
const sockets = new Set()
let streaming = false

function marker(name) {
  writeFileSync(join(markers, name), '')
}

function stamp() {
  return new Date().toISOString()
}

function appendEntry(entry) {
  appendFileSync(transcriptPath, `${JSON.stringify(entry)}\n`)
}

function broadcast(frame) {
  const line = `${JSON.stringify(frame)}\n`
  for (const socket of sockets) socket.write(line)
}

function cleanup() {
  for (const path of [sidecarPath, socketPath]) {
    try { unlinkSync(path) } catch {}
  }
}

mkdirSync(publicationDir, { recursive: true })
mkdirSync(markers, { recursive: true })
writeFileSync(transcriptPath, `${JSON.stringify({
  type: 'session',
  id: sessionId,
  timestamp: stamp(),
  cwd: process.cwd(),
})}\n`)

process.stdout.write(`${JSON.stringify({
  type: 'ready',
  protocolVersion: 1,
  supportedProtocolVersions: [1],
  maxFrameBytes: 1024 * 1024,
})}\n`)

function runTurn(promptId, text) {
  streaming = true
  appendEntry({
    type: 'message',
    id: 'entry-u1',
    parentId: sessionId,
    timestamp: stamp(),
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
  broadcast({ type: 'agent_start' })
  broadcast({ type: 'message_start', messageId: 'a1', message: { role: 'assistant' } })
  broadcast({
    type: 'message_update',
    messageId: 'a1',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Starting the slow tool.' }] },
    assistantMessageEvent: { type: 'done' },
  })
  appendEntry({
    type: 'message',
    id: 'entry-a1',
    parentId: 'entry-u1',
    timestamp: stamp(),
    message: {
      role: 'assistant',
      provider: 'fake',
      model: 'fake',
      content: [
        { type: 'text', text: 'Starting the slow tool.' },
        { type: 'toolCall', id: 'call-slow', name: 'bash', arguments: { command: 'sleep 1' }, intent: 'run the slow tool' },
      ],
    },
  })
  broadcast({
    type: 'tool_execution_start',
    toolCallId: 'call-slow',
    toolName: 'bash',
    args: { command: 'sleep 1' },
    intent: 'run the slow tool',
  })
  marker('tool-started')
  setTimeout(() => {
    appendEntry({
      type: 'message',
      id: 'entry-t1',
      parentId: 'entry-a1',
      timestamp: stamp(),
      message: { role: 'toolResult', toolCallId: 'call-slow', isError: false, content: [{ type: 'text', text: 'ok' }] },
    })
    broadcast({
      type: 'tool_execution_end',
      toolCallId: 'call-slow',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'ok' }] },
    })
    appendEntry({
      type: 'message',
      id: 'entry-a2',
      parentId: 'entry-t1',
      timestamp: stamp(),
      message: { role: 'assistant', provider: 'fake', model: 'fake', content: [{ type: 'text', text: 'done' }] },
    })
    broadcast({ type: 'message_start', messageId: 'a2', message: { role: 'assistant' } })
    broadcast({
      type: 'message_update',
      messageId: 'a2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      assistantMessageEvent: { type: 'done' },
    })
    broadcast({ type: 'prompt_result', id: promptId, agentInvoked: true, status: 'completed', sessionSettled: true })
    broadcast({ type: 'agent_end', isTerminal: true })
    streaming = false
    marker('turn-finished')
  }, toolDelayMs)
}

function answer(frame, socket) {
  const data = (() => {
    switch (frame.type) {
      case 'get_state':
        return { sessionId, sessionFile: transcriptPath, cwd: process.cwd(), isStreaming: streaming, todoPhases: [] }
      case 'get_available_models':
        return { models: [] }
      case 'get_available_commands':
        return { commands: [] }
      case 'prompt':
        runTurn(frame.id, typeof frame.message === 'string' ? frame.message : '')
        return {}
      default:
        return {}
    }
  })()
  socket.write(`${JSON.stringify({ type: 'response', id: frame.id, command: frame.type, success: true, data })}\n`)
}

const server = createServer((socket) => {
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
  socket.on('data', (chunk) => {
    buffered += chunk
    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      try { answer(JSON.parse(line), socket) } catch {}
      newline = buffered.indexOf('\n')
    }
  })
})

server.listen(socketPath, () => {
  const temporary = `${sidecarPath}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({
    pid: process.pid,
    sessionId,
    sessionFile: transcriptPath,
    cwd: process.cwd(),
    agent: 'default',
    startedAt: stamp(),
  }))
  renameSync(temporary, sidecarPath)
})

process.stdin.resume()
process.stdin.on('end', () => {
  marker('stdin-ended')
  cleanup()
  process.exit(0)
})
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    cleanup()
    process.exit(0)
  })
}
