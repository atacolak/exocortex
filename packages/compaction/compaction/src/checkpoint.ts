/**
 * Compaction checkpoint contract: the correlated source constructor and
 * predicate every backend uses for its replacement user message, plus the
 * framing that makes that message established context.
 *
 * The seam itself lives in `@deepseek-ai/dsh-compaction`, which re-exports these
 * contracts; this module is a pure type/value/predicate outlet (no cordis
 * imports, no module augmentation) so client and wire programs can name the
 * checkpoint source without loading the host plugin's Context merges — the
 * `dsh-commands/brand` shape.
 *
 * @module @deepseek-ai/dsh-compaction/checkpoint
 */

import type { MessageSource } from '@deepseek-ai/dsh-llm/message'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/message'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { CompactionId } from './brand.ts'

const COMPACT_CHECKPOINT_MARKER = Object.freeze({ kind: 'compact-checkpoint' } as const)

/** Opening tag wrapping the structured summary inside the landed checkpoint node. */
export const SUMMARY_OPEN_TAG = '<compacted-summary>'
/** Closing tag wrapping the structured summary inside the landed checkpoint node. */
export const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/** Framing that makes the replacement user message established context. */
export const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/** Message source carried by a concrete compaction checkpoint. */
export type CompactionCheckpointSource = typeof COMPACT_CHECKPOINT_MARKER & {
  readonly compactionId: CompactionId
  readonly sourceCommandId?: CommandId
}

/**
 * Create a checkpoint source correlated with one compaction transaction.
 * @param compactionId - owning compaction identity.
 * @param sourceCommandId - initiating manual command, when present.
 * @returns immutable checkpoint source.
 */
export function compactCheckpointSource(
  compactionId: CompactionId,
  sourceCommandId?: CommandId,
): CompactionCheckpointSource {
  return Object.freeze({
    ...COMPACT_CHECKPOINT_MARKER,
    compactionId,
    ...sourceCommandId === undefined ? {} : { sourceCommandId },
  })
}

/**
 * Test whether a persisted message source identifies a compaction checkpoint.
 * @param source - source restored from a surface user message.
 * @returns whether the source carries the backend-independent checkpoint marker.
 */
export function isCompactCheckpointSource(source: MessageSource): source is CompactionCheckpointSource {
  return source.kind === 'compact-checkpoint'
}

/**
 * Frame one summary body as the checkpoint replacement the model resumes from.
 *
 * The framing separates the summary from user speech and lets a later
 * compaction recognize it as a prior checkpoint rather than as conversation.
 * @param summary - summary content blocks written by the compaction backend.
 * @returns checkpoint message content blocks with the standard frame.
 */
export function frameCompactionSummary(summary: readonly ContentBlock[]): ContentBlock[] {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}
