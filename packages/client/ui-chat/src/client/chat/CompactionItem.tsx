// A compaction marker does not replace shadowed transcript rows. It is
// expandable only when the current window includes its cited summary.

import { memo, useMemo, useState, type ReactNode } from 'react'
import {
  IconApiOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../contract/slots.ts'
import { markdownLabels } from '../markdown-labels.ts'
import type { CompactionSummaryNode } from '../contract/snapshot.ts'
import { formatTokens } from './token-format.ts'
import css from './MessageItem.module.css'

interface CompactionItemProps {
  node: CompactionSummaryNode
  /** Optional command title for a manual compaction folded into this marker. */
  title?: string
  /** Command settlement text used when structured compaction counts are unavailable. */
  fallbackSummary?: string | null
  /** Render the Session's registered compaction card with this divider as its fallback. */
  renderCard?: ChatNodeOwnerProps['renderCompactionCard']
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}

interface MinimalNeutralCompactionDividerProps {
  readonly title: string
  readonly method: string | null
  readonly summary: string
  readonly expandable: boolean
  readonly open: boolean
  onToggle(): void
  readonly body: ReactNode
}

/**
 * Render the neutral stock compaction divider.
 * @param props - Resolved title, method, summary text, disclosure state, and expanded body.
 * @returns the divider row with its summary disclosure.
 */
export function MinimalNeutralCompactionDivider({
  title, method, summary, expandable, open, onToggle, body,
}: MinimalNeutralCompactionDividerProps) {
  return (
    <div className={css.compactionRow}>
      <button
        type="button"
        className={css.compactionButton}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        data-compaction-method={method ?? undefined}
        onClick={onToggle}
      >
        <span className={css.compactionLeading} aria-hidden>
          <span className={css.compactionContextIcon} data-compaction-icon="context">
            <IconApiOutlineRegular />
          </span>
          <span
            className={css.compactionDisclosureIcon}
            data-compaction-disclosure={open ? 'expanded' : 'collapsed'}
          >
            {open ? <IconChevronDownOutlineRegular /> : <IconChevronRightOutlineRegular />}
          </span>
        </span>
        <span className={css.compactionTitle}>{title}</span>
        {method !== null && <span className={css.compactionMethod}>{method}</span>}
        <span className={css.compactionSep} aria-hidden />
        <span className={css.compactionSummary}>{summary}</span>
      </button>
      {body}
    </div>
  )
}

/**
 * Renders the model-history compaction marker through the compaction card Slot.
 * @param props - the marker node off the snapshot cache.
 * @returns the checkpoint card, with the neutral divider when no occupant registers.
 */
export const CompactionItem = memo(function CompactionItem({
  node,
  title,
  fallbackSummary,
  renderCard,
  t,
}: CompactionItemProps) {
  const [expanded, setExpanded] = useState(false)
  const labels = useMemo(() => markdownLabels(t), [t])
  const expandable = node.summary !== null
  const open = expandable && expanded
  const method = node.method ?? null
  const tokensAfter = node.tokensAfter ?? null
  const reduction = node.shadowedTokenCount !== null && tokensAfter !== null
    ? node.shadowedTokenCount > tokensAfter
      ? t('message.compaction.reductionSaved', {
        before: formatTokens(node.shadowedTokenCount, t),
        after: formatTokens(tokensAfter, t),
        saved: formatTokens(node.shadowedTokenCount - tokensAfter, t),
      })
      : t('message.compaction.reduction', {
        before: formatTokens(node.shadowedTokenCount, t),
        after: formatTokens(tokensAfter, t),
      })
    : null
  const counts = node.shadowedItemCount !== null && node.shadowedTokenCount !== null
    ? t('message.compaction.completed', {
      items: node.shadowedItemCount,
      tokens: node.shadowedTokenCount,
    })
    : null
  const summary = reduction ?? counts ?? fallbackSummary
    ?? (expandable ? t('message.compaction.expand') : t('message.compaction.unavailable'))
  const divider = (
    <MinimalNeutralCompactionDivider
      title={title ?? t('message.compaction')}
      method={method}
      summary={summary}
      expandable={expandable}
      open={open}
      onToggle={() => { setExpanded(value => !value) }}
      body={open && node.summary !== null
        ? <div className={css.compactionBody}><MarkdownText text={node.summary} labels={labels} /></div>
        : null}
    />
  )
  if (renderCard === undefined) return divider
  return renderCard({
    method: node.method ?? undefined,
    tokensBefore: node.shadowedTokenCount ?? undefined,
    tokensAfter: node.tokensAfter ?? undefined,
    summary: node.summary ?? undefined,
    timestamp: node.time,
  }, divider)
})
