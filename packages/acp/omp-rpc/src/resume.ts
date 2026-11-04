/**
 * Resolve a real OMP transcript and resume it in place: prefix lookup over the
 * OMP session root, ownership-lease probing before a second process opens the
 * file, and chat-bubble hydration of its recorded messages into a blank harness
 * session.
 * @module @deepseek-ai/dsh-omp-rpc/resume
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
  type ContentBlock,
  type MessageSourceMap,
} from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { normalizeSessionTitle } from '@deepseek-ai/dsh-session-title'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { ompTriggerSource } from './driver.ts'
import type { OmpTriggerSource } from './types.ts'

/** A resume or open request the HTTP surface can report with a stable status. */
export class OmpResumeError extends Error {
  /**
   * @param code - stable machine code reported to the caller.
   * @param message - caller-facing explanation.
   * @param status - HTTP status when the error crosses the open endpoint.
   */
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'OmpResumeError'
  }
}

/** Facts read from one transcript's `session` header. */
export interface OmpTranscriptHeader {
  /** Absolute transcript path. */
  readonly path: string
  /** Session id recorded in the header. */
  readonly id: string
  /** Working directory the session was started in. */
  readonly cwd?: string
  /** Root agent profile recorded by `--agent`, when one was used. */
  readonly profile?: string
  /** Session creation timestamp. */
  readonly timestamp?: string
}

interface SessionEntry {
  readonly type?: unknown
  readonly id?: unknown
  readonly cwd?: unknown
  readonly rootAgent?: unknown
  readonly timestamp?: unknown
}

/**
 * Read the `session` header out of one transcript.
 * @param path - absolute transcript path.
 * @returns header facts, including the path.
 * @throws when the file holds no session header.
 */
export async function readOmpTranscriptHeader(path: string): Promise<OmpTranscriptHeader> {
  const text = await readFile(path, 'utf8')
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let entry: SessionEntry
    try {
      entry = JSON.parse(line) as SessionEntry
    } catch {
      continue
    }
    if (entry.type !== 'session' || typeof entry.id !== 'string' || entry.id.length === 0) continue
    return {
      path: resolve(path),
      id: entry.id,
      ...typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {},
      ...typeof entry.rootAgent === 'string' && entry.rootAgent.length > 0 ? { profile: entry.rootAgent } : {},
      ...typeof entry.timestamp === 'string' ? { timestamp: entry.timestamp } : {},
    }
  }
  throw new Error(`OMP transcript has no session header: ${path}`)
}

/**
 * List the transcripts directly under one OMP session root's project
 * directories, newest file first.
 * @param root - OMP session root (`~/.omp/agent/sessions`).
 * @returns transcript paths; unreadable directories contribute nothing.
 */
export async function listOmpTranscripts(root: string): Promise<string[]> {
  const projects = await readdir(root, { withFileTypes: true }).catch(() => [])
  const paths: string[] = []
  for (const project of projects) {
    if (!project.isDirectory() && !project.isSymbolicLink()) continue
    const dir = join(root, project.name)
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!(entry.isFile() || entry.isSymbolicLink()) || !entry.name.endsWith('.jsonl')) continue
      paths.push(join(dir, entry.name))
    }
  }
  return paths.sort((left, right) => right.localeCompare(left))
}

/** One resolved transcript and its header. */
export interface OmpTranscriptMatch extends OmpTranscriptHeader {
  /** Filename stem before the session id, useful in diagnostics. */
  readonly file: string
}

function transcriptIdOf(path: string): string | undefined {
  const stem = basename(path, '.jsonl')
  const underscore = stem.lastIndexOf('_')
  if (underscore === -1 || underscore === stem.length - 1) return undefined
  return stem.slice(underscore + 1)
}

/**
 * Resolve one transcript by UUID prefix or exact path.
 *
 * A prefix matches the session id recorded in the header or the id embedded in
 * the filename. An exact header id wins over prefix matches; several distinct
 * prefix matches are refused rather than guessed.
 * @param root - OMP session root.
 * @param prefix - UUID prefix, full id, or transcript path.
 * @returns the single matching transcript.
 */
export async function resolveOmpTranscript(root: string, prefix: string): Promise<OmpTranscriptMatch> {
  const trimmed = prefix.trim()
  if (trimmed.length === 0) throw new Error('expected a session id or prefix')
  if (isAbsolute(trimmed) || trimmed.includes('/') || trimmed.endsWith('.jsonl')) {
    const path = resolve(trimmed)
    const info = await stat(path).catch(() => undefined)
    if (info === undefined || !info.isFile()) throw new Error(`OMP transcript not found: ${path}`)
    const header = await readOmpTranscriptHeader(path)
    return { ...header, file: basename(path) }
  }
  const wanted = trimmed.toLowerCase()
  const matches: OmpTranscriptMatch[] = []
  for (const path of await listOmpTranscripts(root)) {
    const id = transcriptIdOf(path)
    const fileMatch = id?.toLowerCase().startsWith(wanted) === true
      || basename(path, '.jsonl').toLowerCase().startsWith(wanted)
    if (!fileMatch) continue
    const header = await readOmpTranscriptHeader(path).catch(() => undefined)
    if (header === undefined) continue
    matches.push({ ...header, file: basename(path) })
  }
  if (matches.length === 0) throw new Error(`no OMP transcript matches "${trimmed}" under ${root}`)
  const exact = matches.filter(match => match.id.toLowerCase() === wanted)
  if (exact.length === 1) return exact[0] as OmpTranscriptMatch
  const distinct = [...new Map(matches.map(match => [match.id, match])).values()]
  if (distinct.length === 1) return distinct[0] as OmpTranscriptMatch
  const listing = distinct.slice(0, 5).map(match => `${match.id.slice(0, 8)} (${match.path})`).join(', ')
  throw new Error(`"${trimmed}" matches ${String(distinct.length)} OMP sessions: ${listing}`)
}

/** Whether a process still owns one session's write lease. */
export interface OmpLeaseReport {
  /** Session ids a running process owns. */
  readonly held: readonly string[]
  /** Session ids whose lease could not be probed. */
  readonly unknown: readonly string[]
}

/**
 * Parse `omp session lease --json` output.
 * @param text - command stdout.
 * @returns the held and unknown id lists.
 */
export function parseOmpLeaseReport(text: string): OmpLeaseReport {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('omp session lease returned no report')
  const record = parsed as { held?: unknown; unknown?: unknown }
  const held = Array.isArray(record.held) ? record.held.filter((id): id is string => typeof id === 'string') : []
  const unknown = Array.isArray(record.unknown) ? record.unknown.filter((id): id is string => typeof id === 'string') : []
  return { held, unknown }
}

/**
 * Probe one session's ownership lease through OMP's own lock implementation.
 * @param runtime - host subprocess provider.
 * @param executable - resolved OMP executable.
 * @param id - session id from the transcript header.
 * @param cwd - existing working directory for the probe process.
 * @returns the report, or throws when the probe cannot produce one.
 */
export async function probeOmpSessionLease(
  runtime: SubprocessRuntime,
  executable: string,
  id: string,
  cwd: string,
): Promise<OmpLeaseReport> {
  const handle = runtime.spawn({
    argv: [executable, 'session', 'lease', '--json', '--', id],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64 * 1024 },
      stderr: { maxBytes: 64 * 1024 },
    },
    graceMs: 2_000,
    signal: AbortSignal.timeout(15_000),
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  if (outcome.exitCode !== 0) {
    throw new Error(`omp session lease failed (${String(outcome.exitCode ?? outcome.signal)}): ${stderr.trim().slice(-400)}`)
  }
  try {
    return parseOmpLeaseReport(stdout)
  } catch (error: unknown) {
    throw new Error(`omp session lease returned unreadable output: ${stdout.trim().slice(-200)}`, { cause: error })
  }
}

/** One harness session event reconstructed from a recorded OMP transcript. */
export type OmpHydrationEvent =
  | { readonly type: 'turn/start'; readonly data: SessionEvent<'turn/start'>['data'] }
  | { readonly type: 'turn/end'; readonly data: SessionEvent<'turn/end'>['data'] }
  | { readonly type: 'step/start'; readonly data: SessionEvent<'step/start'>['data'] }
  | { readonly type: 'step/end'; readonly data: SessionEvent<'step/end'>['data'] }
  | { readonly type: 'user/message'; readonly data: SessionEvent<'user/message'>['data'] }
  | { readonly type: 'assistant/message'; readonly data: SessionEvent<'assistant/message'>['data'] }
  | { readonly type: 'tool/call'; readonly data: SessionEvent<'tool/call'>['data'] }
  | { readonly type: 'tool/result'; readonly data: SessionEvent<'tool/result'>['data'] }

interface TranscriptContentPart {
  readonly type?: unknown
  readonly text?: unknown
  readonly thinking?: unknown
  readonly id?: unknown
  readonly name?: unknown
  readonly arguments?: unknown
  readonly intent?: unknown
}

interface TranscriptMessage {
  readonly role?: unknown
  readonly content?: unknown
  readonly provider?: unknown
  readonly model?: unknown
  readonly toolCallId?: unknown
  readonly isError?: unknown
}

interface TranscriptMessageEntry {
  readonly type?: unknown
  readonly customType?: unknown
  readonly message?: TranscriptMessage
  readonly data?: unknown
}

function toolArgumentsWithIntent(raw: unknown, intent: unknown): string {
  const args = recordOf(raw)
  if (typeof intent !== 'string' || intent.length === 0) return JSON.stringify(args)
  return JSON.stringify({ i: intent, ...args })
}

function recordOf(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      return recordOf(parsed)
    } catch {
      return {}
    }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as Record<string, unknown>
}

function partsOf(content: unknown): TranscriptContentPart[] {
  if (!Array.isArray(content)) return []
  return content.filter((part): part is TranscriptContentPart => typeof part === 'object' && part !== null)
}

function userMessageSource(content: readonly ContentBlock[]): MessageSourceMap['user'] | OmpTriggerSource {
  const text = content.map(block => block.type === 'text' ? block.text : '').join('\n')
  return ompTriggerSource(text) ?? { kind: 'user' }
}

function textBlocks(content: unknown): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const part of partsOf(content)) {
    if (part.type === 'text' && typeof part.text === 'string') {
      if (part.text.length > 0) blocks.push({ type: 'text', text: part.text })
      continue
    }
    if (part.type === 'image') blocks.push({ type: 'text', text: '[image]' })
  }
  return blocks
}

function assistantBlocks(
  content: unknown,
  toolStarts: ReadonlyMap<string, { readonly args: unknown; readonly intent: unknown }>,
): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const part of partsOf(content)) {
    if (part.type === 'thinking' && typeof part.thinking === 'string') {
      if (part.thinking.length > 0) blocks.push({ type: 'reasoning', text: part.thinking })
      continue
    }
    if (part.type === 'text' && typeof part.text === 'string') {
      if (part.text.length > 0) blocks.push({ type: 'text', text: part.text })
      continue
    }
    if (part.type === 'image') {
      blocks.push({ type: 'text', text: '[image]' })
      continue
    }
    if (part.type === 'toolCall' && typeof part.id === 'string' && typeof part.name === 'string') {
      const recorded = toolStarts.get(part.id)
      blocks.push({
        type: 'tool-call',
        id: ToolCallId(part.id),
        name: part.name,
        arguments: toolArgumentsWithIntent(
          part.arguments ?? recorded?.args,
          part.intent ?? recorded?.intent,
        ),
      })
    }
  }
  return blocks
}

/** Maximum UTF-8 bytes of a hydrated OMP title, matching the title service default. */
const OMP_TITLE_MAX_BYTES = 200

interface TranscriptTitleEntry {
  readonly type?: unknown
  readonly title?: unknown
  readonly updatedAt?: unknown
  readonly timestamp?: unknown
}

/**
 * Read the newest non-empty title recorded by one OMP transcript.
 *
 * OMP keeps the current title on the transcript's first `title` line and also
 * appends `title_change` records; the newest timestamp wins, and file order
 * breaks ties.
 * @param path - transcript path.
 * @returns the normalized title, or undefined when the transcript carries none.
 */
export async function readOmpTranscriptTitle(path: string): Promise<string | undefined> {
  const text = await readFile(path, 'utf8')
  let newest: { readonly title: string; readonly at: number } | undefined
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let entry: TranscriptTitleEntry
    try {
      entry = JSON.parse(line) as TranscriptTitleEntry
    } catch {
      continue
    }
    if (entry.type !== 'title' && entry.type !== 'title_change' && entry.type !== 'session') continue
    if (typeof entry.title !== 'string') continue
    const title = normalizeSessionTitle(entry.title, OMP_TITLE_MAX_BYTES)
    if (title.length === 0) continue
    const stamp = typeof entry.updatedAt === 'string' ? entry.updatedAt : entry.timestamp
    const parsed = typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN
    const at = Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
    if (newest === undefined || at >= newest.at) newest = { title, at }
  }
  return newest?.title
}

/** One turn a real OMP transcript recorded, carrying its absolute 1-based index. */
export interface OmpTranscriptTurn {
  /** Position of this turn in OMP's own conversation order. */
  readonly turn: number
  /** Structural, message, and tool events the turn recorded. */
  readonly events: readonly OmpHydrationEvent[]
}

/**
 * Rebuild every turn a real OMP transcript recorded, each carrying the
 * absolute 1-based index OMP's own conversation order assigns it, so a
 * partially mirrored session can append only the turns it is missing.
 * @param path - transcript path.
 * @returns ordered turns with their structural, message, and tool events.
 */
export async function ompTranscriptTurns(path: string): Promise<OmpTranscriptTurn[]> {
  const text = await readFile(path, 'utf8')
  const turns: OmpHydrationEvent[][] = []
  let current: OmpHydrationEvent[] | undefined
  let turn = 0
  let step = 0
  let stepHasAssistant = false

  const closeTurn = (): void => {
    if (current === undefined) return
    current.push({ type: 'step/end', data: { turn, step } })
    current.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
    turns.push(current)
    current = undefined
    stepHasAssistant = false
  }
  const openTurn = (): OmpHydrationEvent[] => {
    turn += 1
    step = 1
    stepHasAssistant = false
    const events: OmpHydrationEvent[] = [
      { type: 'turn/start', data: { turn } },
      { type: 'step/start', data: { turn, step } },
    ]
    current = events
    return events
  }
  const openStep = (events: OmpHydrationEvent[]): void => {
    events.push({ type: 'step/end', data: { turn, step } })
    step += 1
    stepHasAssistant = false
    events.push({ type: 'step/start', data: { turn, step } })
  }

  const messages: TranscriptMessage[] = []
  const toolStarts = new Map<string, { readonly args: unknown; readonly intent: unknown }>()
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let entry: TranscriptMessageEntry
    try {
      entry = JSON.parse(line) as TranscriptMessageEntry
    } catch {
      continue
    }
    if (entry.type === 'custom' && entry.customType === 'tool_execution_start') {
      const data = recordOf(entry.data)
      if (typeof data.toolCallId === 'string' && data.toolCallId.length > 0) {
        toolStarts.set(data.toolCallId, { args: data.args, intent: data.intent })
      }
      continue
    }
    if (entry.type !== 'message' || entry.message === undefined) continue
    messages.push(entry.message)
  }

  const resultsBeforeNextMessage = (index: number): ReadonlySet<string> => {
    const ids = new Set<string>()
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      const next = messages[cursor] as TranscriptMessage
      if (next.role === 'user' || next.role === 'assistant') break
      if (next.role === 'toolResult' && typeof next.toolCallId === 'string' && next.toolCallId.length > 0) {
        ids.add(next.toolCallId)
      }
    }
    return ids
  }

  const openCalls = new Set<string>()
  for (const [index, message] of messages.entries()) {
    if (message.role === 'user') {
      const content = textBlocks(message.content)
      if (content.length === 0) continue
      closeTurn()
      openTurn().push({
        type: 'user/message',
        data: createUserMessage({ content, source: userMessageSource(content) }),
      })
      continue
    }
    if (message.role === 'assistant') {
      const results = resultsBeforeNextMessage(index)
      const content = assistantBlocks(message.content, toolStarts)
        .filter(block => block.type !== 'tool-call' || results.has(block.id))
      if (content.length === 0) continue
      const events = current ?? openTurn()
      if (stepHasAssistant) openStep(events)
      const provider = typeof message.provider === 'string' && message.provider.length > 0 ? message.provider : 'omp'
      const model = typeof message.model === 'string' && message.model.length > 0 ? message.model : 'omp'
      events.push({
        type: 'assistant/message',
        data: {
          turn,
          step,
          message: createAssistantMessage({ content, source: { provider, model } }),
          stream: [],
        },
      })
      stepHasAssistant = true
      for (const block of content) {
        if (block.type !== 'tool-call') continue
        events.push({
          type: 'tool/call',
          data: { turn, step, callId: block.id, name: block.name, arguments: block.arguments },
        })
        openCalls.add(block.id)
      }
      continue
    }
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string' && message.toolCallId.length > 0) {
      const callId = ToolCallId(message.toolCallId)
      if (current === undefined || !openCalls.delete(callId)) continue
      const content = textBlocks(message.content)
      current.push({
        type: 'tool/result',
        data: {
          turn,
          step,
          message: createToolResultMessage({
            callId,
            content,
            isError: message.isError === true,
          }),
        },
      })
    }
  }
  closeTurn()
  return turns.map((events, index) => ({ turn: index + 1, events }))
}

function newestTurns(turns: readonly OmpTranscriptTurn[], limit: number): OmpTranscriptTurn[] {
  const selected: OmpTranscriptTurn[] = []
  let total = 0
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const entry = turns[index] as OmpTranscriptTurn
    if (selected.length > 0 && total + entry.events.length > limit) break
    selected.unshift(entry)
    total += entry.events.length
  }
  return selected
}

function oldestTurns(turns: readonly OmpTranscriptTurn[], limit: number): OmpTranscriptTurn[] {
  const selected: OmpTranscriptTurn[] = []
  let total = 0
  for (const entry of turns) {
    if (selected.length > 0 && total + entry.events.length > limit) break
    selected.push(entry)
    total += entry.events.length
  }
  return selected
}

function renumberTurn(events: readonly OmpHydrationEvent[], turn: number): OmpHydrationEvent[] {
  return events.map((event): OmpHydrationEvent => {
    switch (event.type) {
      case 'turn/start':
        return { type: 'turn/start', data: { ...event.data, turn } }
      case 'turn/end':
        return { type: 'turn/end', data: { ...event.data, turn } }
      case 'step/start':
        return { type: 'step/start', data: { ...event.data, turn } }
      case 'step/end':
        return { type: 'step/end', data: { ...event.data, turn } }
      case 'assistant/message':
        return { type: 'assistant/message', data: { ...event.data, turn } }
      case 'tool/call':
        return { type: 'tool/call', data: { ...event.data, turn } }
      case 'tool/result':
        return { type: 'tool/result', data: { ...event.data, turn } }
      case 'user/message':
        return event
    }
  })
}

/**
 * Rebuild the harness session events a real OMP transcript recorded, so an
 * opened or resumed session shows the same user, assistant, and tool bubbles
 * instead of one summarized seed message. Turn and step boundaries make those
 * bubbles visible to projections that require them.
 * @param path - transcript path.
 * @param limit - maximum events selected from the newest complete turns; the newest turn is always included.
 * @returns ordered events ready to append to a blank harness session.
 */
export async function ompHydrationEvents(path: string, limit = 200): Promise<OmpHydrationEvent[]> {
  return newestTurns(await ompTranscriptTurns(path), limit)
    .flatMap((entry, index) => renumberTurn(entry.events, index + 1))
}

/** Turns one harness session already projects, from its structural events. */
export function projectedTurnCount(
  session: { snapshotEvents(): readonly { readonly type: string; readonly data?: unknown }[] },
): number {
  let turns = 0
  let users = 0
  for (const event of session.snapshotEvents()) {
    if (event.type === 'user/message') users += 1
    if (event.type !== 'turn/start') continue
    const turn = recordOf(event.data)?.turn
    if (typeof turn === 'number' && turn > turns) turns = turn
  }
  return turns > 0 ? turns : users
}

function projectedTitle(
  session: { snapshotEvents(): readonly { readonly type: string; readonly data?: unknown }[] },
): string | undefined {
  let title: string | undefined
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'session/title') continue
    const value = recordOf(event.data)?.title
    if (typeof value === 'string') title = value
  }
  return title
}

/** What one hydration pass appended to a harness session. */
export interface OmpHydrationOutcome {
  /** Events appended to the harness session. */
  readonly appended: number
  /** Contiguous turn count the session now holds through. */
  readonly turns: number
}

/**
 * Append a transcript's recorded title and surface events to a harness
 * session, filling only the turns the session does not already project.
 *
 * A blank session receives the newest complete turns the event limit admits.
 * An already-mirrored session receives the turns OMP recorded after it, in
 * transcript order and renumbered contiguously after the turns it holds, so a
 * live terminal run that kept working while the Harness was detached catches
 * up without duplicating bubbles.
 * @param session - live session receiving the events.
 * @param path - transcript path.
 * @param limit - maximum events selected by one pass; at least one turn is always included.
 * @param hydratedTurns - turn count a previous hydration recorded, when the binding still has it.
 * @param includeNewestTurn - false leaves the last transcript turn out because OMP is still streaming it.
 * @returns the appended event count and the contiguous turn count the session now holds.
 */
export async function hydrateOmpSession(
  session: Session,
  path: string,
  limit = 200,
  hydratedTurns = 0,
  includeNewestTurn = true,
): Promise<OmpHydrationOutcome> {
  const existing = Math.max(projectedTurnCount(session), hydratedTurns)
  const pending = (await ompTranscriptTurns(path)).filter(entry => entry.turn > existing)
  const selectable = includeNewestTurn ? pending : pending.slice(0, -1)
  const selected = existing === 0 && hydratedTurns === 0
    ? newestTurns(selectable, limit).map((entry, index) => renumberTurn(entry.events, index + 1))
    : oldestTurns(selectable, limit).map((entry, index) => renumberTurn(entry.events, existing + index + 1))
  const title = await readOmpTranscriptTitle(path)
  const appendedTitle = title !== undefined && title !== projectedTitle(session) ? title : undefined
  if (appendedTitle !== undefined) {
    session.append('session/title', { title: appendedTitle, messageSeqs: [], source: { kind: 'user' } })
  }
  const events = selected.flat()
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        session.append('turn/start', event.data)
        break
      case 'turn/end':
        session.append('turn/end', event.data)
        break
      case 'step/start':
        session.append('step/start', event.data)
        break
      case 'step/end':
        session.append('step/end', event.data)
        break
      case 'user/message':
        session.append('user/message', event.data, { surfaceOp: 'append' })
        break
      case 'assistant/message':
        session.append('assistant/message', event.data, { surfaceOp: 'append' })
        break
      case 'tool/call':
        session.append('tool/call', event.data)
        break
      case 'tool/result':
        session.append('tool/result', event.data, { surfaceOp: 'append' })
        break
    }
  }
  return { appended: events.length + (appendedTitle === undefined ? 0 : 1), turns: existing + selected.length }
}
