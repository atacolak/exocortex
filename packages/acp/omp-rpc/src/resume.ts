/**
 * Resolve a real OMP transcript and resume it in place: prefix lookup over the
 * OMP session root, ownership-lease probing before a second process opens the
 * file, and chat-bubble hydration of its recorded messages into a blank harness
 * session.
 * @module @deepseek-ai/dsh-omp-rpc/resume
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { compactCheckpointSource, frameCompactionSummary } from '@deepseek-ai/dsh-compaction/checkpoint'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
  type ContentBlock,
  type MessageSourceMap,
} from '@deepseek-ai/dsh-llm'
import { foldSurface, type Session, type SessionAppendTiming, type SessionEvent } from '@deepseek-ai/dsh-session'
import { normalizeSessionTitle } from '@deepseek-ai/dsh-session-title'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { ompGenericWakeSource, ompTriggerSource } from './driver.ts'
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
  | { readonly type: 'turn/start'; readonly data: SessionEvent<'turn/start'>['data']; readonly time?: number }
  | { readonly type: 'turn/end'; readonly data: SessionEvent<'turn/end'>['data']; readonly time?: number }
  | { readonly type: 'step/start'; readonly data: SessionEvent<'step/start'>['data']; readonly time?: number }
  | { readonly type: 'step/end'; readonly data: SessionEvent<'step/end'>['data']; readonly time?: number }
  | { readonly type: 'user/message'; readonly data: SessionEvent<'user/message'>['data']; readonly time?: number }
  | { readonly type: 'assistant/message'; readonly data: SessionEvent<'assistant/message'>['data']; readonly time?: number }
  | { readonly type: 'tool/call'; readonly data: SessionEvent<'tool/call'>['data']; readonly time?: number }
  | { readonly type: 'tool/result'; readonly data: SessionEvent<'tool/result'>['data']; readonly time?: number }

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
  readonly id?: unknown
  readonly parentId?: unknown
  readonly timestamp?: unknown
  readonly customType?: unknown
  readonly content?: unknown
  readonly display?: unknown
  readonly message?: TranscriptMessage
  readonly data?: unknown
  readonly summary?: unknown
  readonly shortSummary?: unknown
  readonly tokensBefore?: unknown
  readonly tokensAfter?: unknown
  readonly method?: unknown
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

/** Attribution for a custom card OMP recorded; it is never operator prose. */
function customMessageSource(content: readonly ContentBlock[]): OmpTriggerSource {
  const text = content.map(block => block.type === 'text' ? block.text : '').join('\n')
  return ompTriggerSource(text) ?? ompGenericWakeSource(text)
}

/** Read a `custom_message` entry's content, which OMP records as a string or parts. */
function customContent(raw: unknown): ContentBlock[] {
  if (typeof raw === 'string') return raw.trim().length === 0 ? [] : [{ type: 'text', text: raw }]
  return textBlocks(raw)
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
  /** Transcript entry id that opened this turn with a real user message. */
  readonly userEntryId?: string
  /** Transcript entry id at which this turn's hydrated history ends. */
  readonly leafEntryId?: string
  /** Structural, message, and tool events the turn recorded. */
  readonly events: readonly OmpHydrationEvent[]
  /** Compaction boundaries OMP recorded before this turn's first message. */
  readonly boundariesBefore?: readonly OmpTranscriptCompaction[]
  /** Compaction boundaries OMP recorded after this turn and before the next one. */
  readonly boundariesAfter?: readonly OmpTranscriptCompaction[]
}

/** One compaction boundary an OMP transcript recorded between its messages. */
export interface OmpTranscriptCompaction {
  /** Identity OMP assigned the compaction entry. */
  readonly entryId: string
  /** Historical time recorded on the entry, epoch-ms when it parses. */
  readonly time?: number
  /** Summary body OMP recorded as the replacement context. */
  readonly summary: string
  /** Condensed summary OMP recorded for display, when present. */
  readonly shortSummary?: string
  /** Context tokens the boundary replaced. */
  readonly tokensBefore: number
  /** Context tokens remaining after the boundary, when OMP projected them. */
  readonly tokensAfter?: number
  /** Compaction method OMP used, when it recorded one. */
  readonly method?: string
}

function entryIdOf(entry: TranscriptMessageEntry): string | undefined {
  return typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : undefined
}

/** Read one compaction entry's boundary facts, or nothing when it cannot replace context. */
function compactionOf(entry: TranscriptMessageEntry, time: number | undefined): OmpTranscriptCompaction | undefined {
  const entryId = entryIdOf(entry)
  if (entryId === undefined || typeof entry.summary !== 'string' || entry.summary.trim().length === 0) return undefined
  const tokensBefore = typeof entry.tokensBefore === 'number' && Number.isFinite(entry.tokensBefore)
    ? Math.max(0, Math.trunc(entry.tokensBefore))
    : 0
  const tokensAfter = typeof entry.tokensAfter === 'number' && Number.isFinite(entry.tokensAfter)
    ? Math.max(0, Math.trunc(entry.tokensAfter))
    : undefined
  const method = typeof entry.method === 'string' && entry.method.length > 0 ? entry.method : undefined
  const shortSummary = typeof entry.shortSummary === 'string' && entry.shortSummary.length > 0
    ? entry.shortSummary
    : undefined
  return {
    entryId,
    ...time === undefined ? {} : { time },
    summary: entry.summary,
    ...shortSummary === undefined ? {} : { shortSummary },
    tokensBefore,
    ...tokensAfter === undefined ? {} : { tokensAfter },
    ...method === undefined ? {} : { method },
  }
}

/** One compaction boundary read back from a transcript's newest records. */
export interface OmpTranscriptCompactionTail {
  /** Boundary facts the newest compaction entry recorded. */
  readonly compaction: OmpTranscriptCompaction
  /** Entry the compacted branch continued from; hydrating through it represents everything before the boundary. */
  readonly parentEntryId?: string
  /** Transcript bytes carrying the boundary; hydrating past it needs no second read. */
  readonly byteOffset: number
}

/**
 * Read the newest compaction entry a transcript recorded.
 *
 * Live RPC compaction announces that a boundary finished but never names the
 * entry it wrote, while the durable entry is the only place OMP records the
 * compaction method and the projected context size. Reading only the tail keeps
 * a live boundary identical to the one hydration projects from the same entry.
 * @param path - transcript path.
 * @returns the newest boundary and the file size that carried it, or nothing when no compaction is recorded.
 */
export async function tailOmpTranscriptCompaction(path: string): Promise<OmpTranscriptCompactionTail | undefined> {
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined || text.length === 0) return undefined
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line === undefined || line.trim().length === 0) continue
    let entry: TranscriptMessageEntry
    try {
      entry = JSON.parse(line) as TranscriptMessageEntry
    } catch {
      continue
    }
    if (entry.type !== 'compaction') continue
    const recorded = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN
    const compaction = compactionOf(entry, Number.isFinite(recorded) ? recorded : undefined)
    if (compaction === undefined) continue
    return {
      compaction,
      ...typeof entry.parentId !== 'string' || entry.parentId.length === 0 ? {} : { parentEntryId: entry.parentId },
      byteOffset: Buffer.byteLength(text, 'utf8'),
    }
  }
  return undefined
}

/**
 * Collect the compaction boundaries one session already projects.
 * @param session - session whose event log is read.
 * @returns identities of every boundary the log already carries.
 */
export function projectedCompactionIds(session: Session): Set<string> {
  const represented = new Set<string>()
  for (const event of session.snapshotEvents()) {
    if (event.type === 'compaction/summary') represented.add(event.data.compactionId)
  }
  return represented
}

/** The turn currently open in one event log, when the log ends inside an unfinished turn. */
function openTurnStart(eventLog: readonly SessionEvent[]): { readonly seq: SessionEvent['seq']; readonly turn: number } | undefined {
  let open: { readonly seq: SessionEvent['seq']; readonly turn: number } | undefined
  for (const event of eventLog) {
    if (event.type === 'turn/start') open = { seq: event.seq, turn: event.data.turn }
    else if (event.type === 'turn/end') open = undefined
  }
  return open
}

/**
 * Flatten the text a message carries, matching how hydration compares prompts.
 * @param content - message content blocks.
 * @returns the text blocks joined by newlines.
 */
function promptText(content: readonly ContentBlock[]): string {
  return content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

/**
 * Read the prompt that opened one turn in a session.
 * @param eventLog - session events to scan.
 * @param turn - turn whose first user message is sought.
 * @returns the prompt text, or undefined when the turn recorded none.
 */
function turnPrompt(eventLog: readonly SessionEvent[], turn: number): string | undefined {
  let inside = false
  for (const event of eventLog) {
    if (event.type === 'turn/start' && event.data.turn === turn) {
      inside = true
      continue
    }
    if (!inside) continue
    if (event.type === 'turn/end' && event.data.turn === turn) return undefined
    if (event.type === 'user/message') return promptText(event.data.content)
  }
  return undefined
}

/**
 * Decide whether a pending transcript turn is the turn the harness holds open,
 * so its committed prefix can be merged into that turn instead of forking it.
 * The prompts must match; a transcript turn the harness never opened has to be
 * renumbered and would collide with the open turn's number.
 * @param session - session whose open turn is compared.
 * @param turn - number of the harness's open turn.
 * @param entry - newest pending transcript turn.
 * @returns whether both turns were opened by the same prompt text.
 */
function opensWithSamePrompt(session: Session, turn: number, entry: OmpTranscriptTurn): boolean {
  const harnessPrompt = turnPrompt(session.snapshotEvents(), turn)
  const candidate = entry.events.find(event => event.type === 'user/message')
  if (harnessPrompt === undefined || candidate?.type !== 'user/message') return false
  return harnessPrompt === promptText(candidate.data.content)
}

/**
 * Append one compaction boundary to a session's surface.
 *
 * This is the single projection every compaction path uses: transcript
 * hydration and live RPC compaction both emit `compaction/start`, the summary
 * that replaces the shadowed surface, the `compact-checkpoint` user message
 * carrying that summary, and `compaction/end`. A boundary that is already in
 * the log is never appended twice, so reopening, waking, or re-observing the
 * same OMP compaction leaves exactly one card.
 * @param session - session receiving the boundary.
 * @param boundary - boundary facts read from the OMP compaction entry.
 * @param timing - append time applied to all four events; omitted uses the session clock.
 * @param sourceCommandId - command that requested a manual compaction, when the caller can correlate it.
 * @returns the boundary identity, or undefined when it is already recorded or nothing can be shadowed.
 */
export function appendOmpCompactionBoundary(
  session: Session,
  boundary: OmpTranscriptCompaction,
  timing: SessionAppendTiming = {},
  sourceCommandId?: CommandId,
): CompactionId | undefined {
  const compactionId = CompactionId(`omp-${boundary.entryId}`)
  if (projectedCompactionIds(session).has(compactionId)) return undefined
  const eventLog = session.snapshotEvents()
  const nodes = foldSurface(eventLog).nodes
  const head = nodes.at(0)
  const surface = head !== undefined && eventLog[head]?.type === 'system/message' ? nodes.slice(1) : nodes
  const open = openTurnStart(eventLog)
  const settled = open === undefined ? surface : surface.filter(seq => seq < open.seq)
  const shadowed = settled.length > 0 ? settled : surface
  const start = shadowed.at(0)
  const end = shadowed.at(-1)
  if (start === undefined || end === undefined) return undefined
  const owner = open?.turn ?? null
  const command = sourceCommandId === undefined ? {} : { sourceCommandId }
  const startEvent = session.append('compaction/start', { compactionId, turn: owner, ...command }, timing)
  const summaryEvent = session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text', text: boundary.summary }],
    shadowedRange: { start, end },
    shadowedSeqs: shadowed,
    shadowedTokenCount: boundary.tokensBefore,
    ...boundary.method === undefined ? {} : { method: boundary.method },
    ...boundary.tokensAfter === undefined ? {} : { tokensAfter: boundary.tokensAfter },
    provider: 'omp',
    model: 'omp',
  }, timing)
  const checkpoint = createUserMessage({
    content: frameCompactionSummary([{ type: 'text', text: boundary.summary }]),
    source: compactCheckpointSource(compactionId, sourceCommandId),
  })
  session.append('user/message', checkpoint, {
    surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowed],
    ...timing,
  })
  session.append('compaction/end', { compactionId, turn: owner, ...command }, timing)
  return compactionId
}

function isSyntheticPrompt(blocks: readonly ContentBlock[]): boolean {
  const text = blocks.map(block => block.type === 'text' ? block.text : '').join('\n').trimStart()
  if (/^omp[:-]continue(?:\b|$)/i.test(text)) return true
  return /^<(?:memories|system-reminder)(?:[\s>]|$)/i.test(text)
}

function timed(event: OmpHydrationEvent, time: number | undefined): OmpHydrationEvent {
  if (time === undefined) return event
  return { ...event, time }
}

/**
 * Order a transcript's records along the active conversation branch.
 *
 * OMP writes a tree: every entry names the entry it continues, and a branch or
 * compaction starts a new child. The newest entry therefore marks the active
 * leaf; walking its parents yields the messages a reader saw, while abandoned
 * siblings stay out. A dangling parent (an entry OMP pruned) leaves no path to
 * the root, so the branch is rebuilt from the newest root forward and the
 * active tail appended, which keeps orphans off the root chain.
 * @param records - every parsed transcript record in file order.
 * @returns records along the active branch in chronological order.
 */
function activeTranscriptBranch(records: readonly TranscriptMessageEntry[]): TranscriptMessageEntry[] {
  const graph = records.some(record => typeof record.id === 'string'
    && (typeof record.parentId === 'string' || record.parentId === null))
  let last = -1
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (entryIdOf(records[index] as TranscriptMessageEntry) !== undefined) {
      last = index
      break
    }
  }
  if (!graph || last === -1) return [...records]

  const byId = new Map<string, number>()
  for (const [index, record] of records.entries()) {
    const id = entryIdOf(record)
    if (id !== undefined && !byId.has(id)) byId.set(id, index)
  }
  const sessionId = records.find(record => record.type === 'session')?.id
  const tail: number[] = []
  const visited = new Set<number>()
  let cursor: unknown = records[last]?.id
  let dangling = false
  while (typeof cursor === 'string' && cursor !== sessionId) {
    const at = byId.get(cursor)
    if (at === undefined) {
      dangling = true
      break
    }
    if (visited.has(at)) break
    visited.add(at)
    tail.push(at)
    cursor = records[at]?.parentId
  }
  const tailRecords = tail.reverse().flatMap(index => {
    const record = records[index]
    return record === undefined ? [] : [record]
  })
  if (!dangling) return tailRecords

  const children = new Map<string, number[]>()
  const roots: number[] = []
  for (const [index, record] of records.entries()) {
    if (record.type === 'session') continue
    const id = entryIdOf(record)
    if (id === undefined) continue
    if (typeof record.parentId !== 'string' || record.parentId === sessionId) {
      roots.push(index)
      continue
    }
    const siblings = children.get(record.parentId) ?? []
    siblings.push(index)
    children.set(record.parentId, siblings)
  }
  const root = roots.at(-1)
  if (root === undefined) return tailRecords

  const forward: TranscriptMessageEntry[] = []
  const walked = new Set<number>()
  let index: number | undefined = root
  while (index !== undefined && !walked.has(index)) {
    walked.add(index)
    const record = records[index]
    if (record === undefined) break
    forward.push(record)
    const id = entryIdOf(record)
    const kids = id === undefined ? undefined : children.get(id)
    index = kids?.at(-1)
  }
  return [...forward, ...tailRecords.filter(record => !forward.includes(record))]
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
  const records: TranscriptMessageEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      records.push(JSON.parse(line) as TranscriptMessageEntry)
    } catch {
      continue
    }
  }
  const ordered = activeTranscriptBranch(records)

  const toolStarts = new Map<string, { readonly args: unknown; readonly intent: unknown }>()
  for (const entry of ordered) {
    if (entry.type !== 'custom' || entry.customType !== 'tool_execution_start') continue
    const data = recordOf(entry.data)
    if (typeof data.toolCallId === 'string' && data.toolCallId.length > 0) {
      toolStarts.set(data.toolCallId, { args: data.args, intent: data.intent })
    }
  }

  const resultsBefore = (position: number): ReadonlySet<string> => {
    const ids = new Set<string>()
    for (let cursor = position + 1; cursor < ordered.length; cursor += 1) {
      const entry = ordered[cursor]
      if (entry === undefined || entry.type !== 'message' || entry.message === undefined) continue
      const role = entry.message.role
      if (role === 'user' || role === 'assistant') break
      const callId = entry.message.toolCallId
      if (role === 'toolResult' && typeof callId === 'string' && callId.length > 0) ids.add(callId)
    }
    return ids
  }

  type TurnDraft = {
    userEntryId?: string
    leafEntryId?: string
    events: OmpHydrationEvent[]
    boundaries?: OmpTranscriptCompaction[]
  }
  const beforeFirst: OmpTranscriptCompaction[] = []
  const drafts: TurnDraft[] = []
  let current: OmpHydrationEvent[] | undefined
  let draft: TurnDraft | undefined
  let turn = 0
  let step = 0
  let stepHasAssistant = false
  let suppressed = false
  let lastTime: number | undefined
  const openCalls = new Set<string>()

  const closeTurn = (): void => {
    if (current === undefined || draft === undefined) return
    current.push(timed({ type: 'step/end', data: { turn, step } }, lastTime))
    current.push(timed({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }, lastTime))
    drafts.push(draft)
    current = undefined
    draft = undefined
    stepHasAssistant = false
  }
  const openTurn = (time: number | undefined, userEntryId: string | undefined): OmpHydrationEvent[] => {
    turn += 1
    step = 1
    stepHasAssistant = false
    const events: OmpHydrationEvent[] = [
      timed({ type: 'turn/start', data: { turn } }, time),
      timed({ type: 'step/start', data: { turn, step } }, time),
    ]
    current = events
    draft = {
      events,
      ...userEntryId === undefined ? {} : { userEntryId, leafEntryId: userEntryId },
    }
    openCalls.clear()
    return events
  }
  const openStep = (events: OmpHydrationEvent[], time: number | undefined): void => {
    events.push(timed({ type: 'step/end', data: { turn, step } }, lastTime))
    step += 1
    stepHasAssistant = false
    events.push(timed({ type: 'step/start', data: { turn, step } }, time))
  }

  for (const [position, entry] of ordered.entries()) {
    const id = entryIdOf(entry)
    const recorded = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN
    const time = Number.isFinite(recorded) ? Math.max(lastTime ?? recorded, recorded) : lastTime
    if (entry.type === 'compaction') {
      const boundary = compactionOf(entry, time)
      if (boundary !== undefined) {
        if (draft === undefined) beforeFirst.push(boundary)
        else (draft.boundaries ??= []).push(boundary)
      }
      if (draft !== undefined && id !== undefined) draft.leafEntryId = id
      continue
    }
    if (entry.type === 'custom_message') {
      const content = customContent(entry.content)
      if (content.length === 0 || entry.display === false) {
        if (draft !== undefined && id !== undefined) draft.leafEntryId = id
        continue
      }
      if (current === undefined) current = openTurn(time, id)
      current.push(timed({
        type: 'user/message',
        data: createUserMessage({ content, source: customMessageSource(content) }),
      }, time))
      lastTime = time ?? lastTime
      if (draft !== undefined && id !== undefined) draft.leafEntryId = id
      continue
    }
    if (entry.type !== 'message' || entry.message === undefined) {
      if (draft !== undefined && id !== undefined) draft.leafEntryId = id
      continue
    }
    const message = entry.message
    if (message.role === 'user') {
      const content = textBlocks(message.content)
      if (content.length === 0) {
        if (draft !== undefined && id !== undefined) draft.leafEntryId = id
        continue
      }
      if (isSyntheticPrompt(content)) {
        suppressed = true
        if (draft !== undefined && id !== undefined) draft.leafEntryId = id
        continue
      }
      suppressed = false
      closeTurn()
      current = openTurn(time, id)
      current.push(timed({
        type: 'user/message',
        data: createUserMessage({ content, source: userMessageSource(content) }),
      }, time))
      lastTime = time ?? lastTime
      continue
    }
    if (suppressed) {
      if (draft !== undefined && id !== undefined) draft.leafEntryId = id
      lastTime = time ?? lastTime
      continue
    }
    if (message.role === 'assistant') {
      const results = resultsBefore(position)
      const content = assistantBlocks(message.content, toolStarts)
        .filter(block => block.type !== 'tool-call' || results.has(block.id))
      if (content.length === 0) {
        if (draft !== undefined && id !== undefined) draft.leafEntryId = id
        continue
      }
      if (current === undefined) continue
      if (stepHasAssistant) openStep(current, time)
      const provider = typeof message.provider === 'string' && message.provider.length > 0 ? message.provider : 'omp'
      const model = typeof message.model === 'string' && message.model.length > 0 ? message.model : 'omp'
      current.push(timed({
        type: 'assistant/message',
        data: {
          turn,
          step,
          message: createAssistantMessage({ content, source: { provider, model } }),
          stream: [],
        },
      }, time))
      stepHasAssistant = true
      for (const block of content) {
        if (block.type !== 'tool-call') continue
        current.push(timed({
          type: 'tool/call',
          data: { turn, step, callId: block.id, name: block.name, arguments: block.arguments },
        }, time))
        openCalls.add(block.id)
      }
      lastTime = time ?? lastTime
      if (draft !== undefined && id !== undefined) draft.leafEntryId = id
      continue
    }
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string' && message.toolCallId.length > 0) {
      const callId = ToolCallId(message.toolCallId)
      if (current === undefined || !openCalls.delete(callId)) continue
      const content = textBlocks(message.content)
      current.push(timed({
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
      }, time))
      lastTime = time ?? lastTime
      if (draft !== undefined && id !== undefined) draft.leafEntryId = id
      continue
    }
    if (draft !== undefined && id !== undefined) draft.leafEntryId = id
  }
  closeTurn()
  return drafts.map((entry, index) => ({
    turn: index + 1,
    ...entry.userEntryId === undefined ? {} : { userEntryId: entry.userEntryId },
    ...entry.leafEntryId === undefined ? {} : { leafEntryId: entry.leafEntryId },
    ...index === 0 && beforeFirst.length > 0 ? { boundariesBefore: beforeFirst } : {},
    ...entry.boundaries === undefined ? {} : { boundariesAfter: entry.boundaries },
    events: entry.events,
  }))
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
        return { ...event, data: { ...event.data, turn } }
      case 'turn/end':
        return { ...event, data: { ...event.data, turn } }
      case 'step/start':
        return { ...event, data: { ...event.data, turn } }
      case 'step/end':
        return { ...event, data: { ...event.data, turn } }
      case 'assistant/message':
        return { ...event, data: { ...event.data, turn } }
      case 'tool/call':
        return { ...event, data: { ...event.data, turn } }
      case 'tool/result':
        return { ...event, data: { ...event.data, turn } }
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
export async function ompHydrationEvents(path: string, limit = Number.POSITIVE_INFINITY): Promise<OmpHydrationEvent[]> {
  return newestTurns(await ompTranscriptTurns(path), limit)
    .flatMap((entry, index) => renumberTurn(entry.events, index + 1))
}

/**
 * Count the turns one harness session already projects, from its structural events.
 * @param session - harness session whose recorded events are counted.
 * @returns the number of turns the session surface already holds.
 */
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

/** High-water cursor a previous hydration persisted for one binding. */
export interface OmpHydrationCursor {
  /** Turn count the previous hydration recorded. */
  readonly hydratedTurns?: number
  /** Canonical transcript entry id the previous hydration consumed. */
  readonly hydratedLeafEntryId?: string
  /** Transcript byte size the previous hydration consumed. */
  readonly hydratedByteOffset?: number
}

/** What one hydration pass appended to a harness session. */
export interface OmpHydrationOutcome {
  /** Events appended to the harness session. */
  readonly appended: number
  /** Contiguous turn count the session now holds through. */
  readonly turns: number
  /** Turn count to persist as the binding's hydration high-water mark. */
  readonly hydratedTurns: number
  /** Transcript entry id the session's projected history now reaches. */
  readonly hydratedLeafEntryId?: string
  /** Transcript byte size the hydration read. */
  readonly hydratedByteOffset?: number
}

/** Content one session already carries from its live turn, used to absorb a re-read prefix. */
interface LiveTurnDedupe {
  readonly userTexts: Set<string>
  readonly callIds: Set<string>
  readonly resultIds: Set<string>
  readonly assistantKeys: Map<string, number>
  /**
   * Steps the harness already started inside its still-open turn. Present only
   * while that turn is open: its `turn/start` and those `step/start` events are
   * already projected, so re-reading them would fork the turn being merged.
   */
  readonly openSteps?: Set<number>
}

/**
 * Collect what a session's open turn already projects, so a re-read of the
 * turn OMP is still writing adds only the events the live socket has not
 * delivered. Prompt and assistant-body identities are bounded to that open
 * turn: a completed turn is never the live projection, and the next transcript
 * turn may legitimately repeat the prompt text it was opened with. Tool
 * identities are global to the log because a resumed harness turn keeps the
 * calls it already advertised.
 * @param session - session whose open turn a transcript turn is about to be merged into.
 * @returns the content identities the open turn already projects.
 */
function liveTurnDedupeOf(session: Session): LiveTurnDedupe {
  const events = session.snapshotEvents()
  let newestTurnStart = events.length
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/start') {
      newestTurnStart = index
      break
    }
  }
  const userTexts = new Set<string>()
  const callIds = new Set<string>()
  const resultIds = new Set<string>()
  const assistantKeys = new Map<string, number>()
  const openTurn = openTurnStart(events)
  const openSteps = openTurn === undefined ? undefined : new Set<number>()
  for (const [index, event] of events.entries()) {
    switch (event.type) {
      case 'tool/call':
        callIds.add(event.data.callId)
        break
      case 'tool/result':
        resultIds.add(event.data.message.toolCallId)
        break
      case 'step/start':
        if (openSteps !== undefined && index >= newestTurnStart) openSteps.add(event.data.step)
        break
      case 'user/message':
        if (index >= newestTurnStart) {
          userTexts.add(promptText(event.data.content))
        }
        break
      case 'assistant/message': {
        if (index < newestTurnStart) break
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') callIds.add(block.id)
        }
        const retained = event.data.message.content.filter(block => block.type !== 'tool-call' || !callIds.has(block.id))
        const key = JSON.stringify(retained.map(block =>
          block.type === 'text' ? ['text', block.text] : [block.type, block.type === 'tool-call' ? block.id : '']))
        assistantKeys.set(key, (assistantKeys.get(key) ?? 0) + 1)
        break
      }
    }
  }
  return { userTexts, callIds, resultIds, assistantKeys, ...openSteps === undefined ? {} : { openSteps } }
}

/**
 * Drop the events one live turn already projects and re-embed the remaining
 * tool-call blocks of a re-read assistant message without the calls the
 * session already advertised.
 * @param events - one transcript turn's events, in log order.
 * @param dedupe - content identities already present, consumed as they match.
 * @returns the events that still need appending.
 */
function dedupeLiveTurn(events: readonly OmpHydrationEvent[], dedupe: LiveTurnDedupe): OmpHydrationEvent[] {
  const kept: OmpHydrationEvent[] = []
  for (const event of events) {
    switch (event.type) {
      case 'user/message':
        if (!dedupe.userTexts.delete(promptText(event.data.content))) kept.push(event)
        break
      case 'assistant/message': {
        const content = event.data.message.content.filter(block => block.type !== 'tool-call' || !dedupe.callIds.has(block.id))
        if (content.length === 0) break
        const key = JSON.stringify(content.map(block =>
          block.type === 'text' ? ['text', block.text] : [block.type, block.type === 'tool-call' ? block.id : '']))
        const remaining = dedupe.assistantKeys.get(key) ?? 0
        if (remaining > 0) {
          dedupe.assistantKeys.set(key, remaining - 1)
          break
        }
        kept.push({
          ...event,
          data: {
            ...event.data,
            message: createAssistantMessage({
              content,
              source: {
                provider: event.data.message.source.provider,
                model: event.data.message.source.model,
              },
            }),
          },
        })
        break
      }
      case 'tool/call':
        if (!dedupe.callIds.has(event.data.callId)) kept.push(event)
        break
      case 'tool/result':
        if (!dedupe.resultIds.has(event.data.message.toolCallId)) kept.push(event)
        break
      case 'turn/start':
        if (dedupe.openSteps === undefined) kept.push(event)
        break
      case 'step/start':
        if (dedupe.openSteps?.delete(event.data.step) !== true) kept.push(event)
        break
      default:
        kept.push(event)
    }
  }
  return kept
}

/**
 * Append a transcript's recorded title and surface events to a harness
 * session, filling only the turns the session does not already project.
 *
 * A blank session receives every active-branch turn the event limit admits.
 * An already-mirrored session receives only the turns the active branch
 * recorded after the cursor leaf it already holds, renumbered contiguously
 * after the turns it holds, so a live terminal run that kept working while the
 * Harness was detached catches up without duplicating bubbles. Without a leaf
 * cursor the newest projected user message anchors the same comparison, so a
 * legacy turn count can never splice older turns under newer ones. Recorded
 * event times are stamped onto the log as-is, clamped non-decreasing from the
 * session's last event, so a cold reload keeps the transcript's chronology.
 * @param session - live session receiving the events.
 * @param path - transcript path.
 * @param limit - maximum events selected by one pass; at least one turn is always included.
 * @param cursorOrHydratedTurns - saved cursor, or the legacy turn count a previous hydration recorded.
 * @returns the appended event count, the contiguous turn count, and the cursor to persist.
 */
export async function hydrateOmpSession(
  session: Session,
  path: string,
  limit = Number.POSITIVE_INFINITY,
  cursorOrHydratedTurns: number | OmpHydrationCursor = 0,
): Promise<OmpHydrationOutcome> {
  const projected = projectedTurnCount(session)
  const cursor: OmpHydrationCursor = projected === 0
    ? { hydratedTurns: 0 }
    : typeof cursorOrHydratedTurns === 'number'
      ? { hydratedTurns: cursorOrHydratedTurns }
      : cursorOrHydratedTurns
  const recorded = cursor.hydratedTurns ?? 0
  const info = await stat(path).catch(() => undefined)
  const byteOffset = info !== undefined && info.isFile() ? info.size : undefined

  if (projected > 0
    && cursor.hydratedLeafEntryId !== undefined
    && cursor.hydratedByteOffset !== undefined
    && byteOffset === cursor.hydratedByteOffset) {
    return {
      appended: 0,
      turns: projected,
      hydratedTurns: projected,
      hydratedLeafEntryId: cursor.hydratedLeafEntryId,
      hydratedByteOffset: cursor.hydratedByteOffset,
    }
  }

  const turns = await ompTranscriptTurns(path)
  const base = projected > 0 ? projected : recorded
  let matched = cursor.hydratedLeafEntryId === undefined
    ? -1
    : turns.findIndex(entry => entry.leafEntryId === cursor.hydratedLeafEntryId)
  if (matched === -1 && projected > 0) {
    const snapshot = session.snapshotEvents()
    let newestUser: typeof snapshot[number] | undefined
    for (let index = snapshot.length - 1; index >= 0; index -= 1) {
      const event = snapshot[index]
      if (event?.type === 'user/message') {
        newestUser = event
        break
      }
    }
    const block = newestUser?.type === 'user/message' ? newestUser.data.content[0] : undefined
    const marker = block?.type === 'text' ? block.text : undefined
    if (marker !== undefined) {
      for (let index = turns.length - 1; index >= 0; index -= 1) {
        const userEvent = turns[index]?.events.find(event => event.type === 'user/message')
        const userBlock = userEvent?.type === 'user/message' ? userEvent.data.content[0] : undefined
        if (userBlock?.type === 'text' && userBlock.text === marker) {
          matched = index
          break
        }
      }
    }
  }
  if (matched === -1) matched = projected > 0 ? turns.length - 1 : recorded - 1

  const pending = turns.slice(matched + 1)
  const openTurnNumber = openTurnStart(session.snapshotEvents())?.turn
  const newestPending = openTurnNumber !== undefined && pending.length === 1 ? pending[0] : undefined
  const mergedInto = newestPending !== undefined && openTurnNumber !== undefined
    && opensWithSamePrompt(session, openTurnNumber, newestPending)
    ? newestPending
    : undefined
  const mergeTurn = mergedInto === undefined ? undefined : openTurnNumber
  const admissible = mergedInto !== undefined || openTurnNumber === undefined
    ? pending
    : pending.slice(0, -1)
  const admitted = base === 0 ? newestTurns(admissible, limit) : oldestTurns(admissible, limit)
  const selected = admitted.map((entry, index) =>
    renumberTurn(entry.events, mergeTurn !== undefined && entry === mergedInto ? mergeTurn : base + index + 1))
  const title = await readOmpTranscriptTitle(path)
  const appendedTitle = title !== undefined && title !== projectedTitle(session) ? title : undefined
  const sessionFloor = session.snapshotEvents().at(-1)?.time
  let floorTime = -Number.MAX_SAFE_INTEGER
  const timingOf = (time: number | undefined): SessionAppendTiming => {
    if (time === undefined) return floorTime === -Number.MAX_SAFE_INTEGER ? {} : { time: floorTime }
    const clamped = Math.max(floorTime, Math.trunc(time))
    floorTime = clamped
    return { time: clamped }
  }
  const firstEventTime = selected[0]?.find(event => event.time !== undefined)?.time
  if (appendedTitle !== undefined) {
    const importedTime = floorTime === -Number.MAX_SAFE_INTEGER ? firstEventTime : floorTime
    const titleTime = importedTime === undefined
      ? sessionFloor
      : sessionFloor === undefined ? importedTime : Math.max(sessionFloor, importedTime)
    session.append('session/title', { title: appendedTitle, messageSeqs: [], source: { kind: 'user' } },
      titleTime === undefined ? {} : { time: titleTime })
  }
  let appendedBoundaries = 0
  const emitBoundary = (boundary: OmpTranscriptCompaction): void => {
    const timing = timingOf(boundary.time)
    if (appendOmpCompactionBoundary(session, boundary, timing) === undefined) return
    appendedBoundaries += 4
  }
  const matchedTurn = matched >= 0 ? turns[matched] : undefined
  for (const boundary of matchedTurn?.boundariesAfter ?? []) emitBoundary(boundary)
  for (const boundary of admitted[0]?.boundariesBefore ?? []) emitBoundary(boundary)
  let appendedEvents = 0
  const liveTurn = mergedInto === undefined ? undefined : liveTurnDedupeOf(session)
  for (const [index, events] of selected.entries()) {
    const batch = liveTurn === undefined || admitted[index] !== mergedInto
      ? events
      : dedupeLiveTurn(events, liveTurn)
    for (const event of batch) {
      appendedEvents += 1
      switch (event.type) {
        case 'turn/start':
          session.append('turn/start', event.data, timingOf(event.time))
          break
        case 'turn/end':
          session.append('turn/end', event.data, timingOf(event.time))
          break
        case 'step/start':
          session.append('step/start', event.data, timingOf(event.time))
          break
        case 'step/end':
          session.append('step/end', event.data, timingOf(event.time))
          break
        case 'user/message':
          session.append('user/message', event.data, { surfaceOp: 'append', ...timingOf(event.time) })
          break
        case 'assistant/message':
          session.append('assistant/message', event.data, { surfaceOp: 'append', ...timingOf(event.time) })
          break
        case 'tool/call':
          session.append('tool/call', event.data, timingOf(event.time))
          break
        case 'tool/result':
          session.append('tool/result', event.data, { surfaceOp: 'append', ...timingOf(event.time) })
          break
      }
    }
    for (const boundary of admitted[index]?.boundariesAfter ?? []) emitBoundary(boundary)
  }
  const newestTurn = admitted.at(-1)
  const leafEntryId = newestTurn?.leafEntryId
    ?? (admitted.length === 0 ? matchedTurn?.leafEntryId : undefined)
  return {
    appended: appendedEvents + appendedBoundaries + (appendedTitle === undefined ? 0 : 1),
    turns: base + selected.length,
    hydratedTurns: base + selected.length,
    ...leafEntryId === undefined ? {} : { hydratedLeafEntryId: leafEntryId },
    ...byteOffset === undefined ? {} : { hydratedByteOffset: byteOffset },
  }
}
