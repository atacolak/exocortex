import { memo, useCallback, useMemo, type KeyboardEvent, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import clsx from 'clsx'
import {
  IconApiOutlineRegular, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconInspectOutlineRegular,
  CommandText, TerminalBlock, TextShimmer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import {
  isBackgroundShellCall,
  localizeTerminalCardModel,
  terminalBlockLabels,
  terminalCardModel,
  terminalFailed,
  terminalExitLabel,
} from '../models/terminal-card-model.ts'
import { formatToolBody, toolRowModel, type ToolRowState } from '../models/tool-call-model.ts'
import { CONVERSATION_NS as NS } from '../../locale.ts'
import { ExitCodeBadge } from '../components/ExitCodeBadge.tsx'
import css from './bash-sample.module.css'

type BashRowProps = ToolCallViewProps & PropsLocale<'conversation'>

const BASH_ICON = <IconApiOutlineRegular size={14} />

/** Visually hidden status for the color-only running sweep and error tone. */
function stateStatus(state: ToolRowState, t: BashRowProps['t']): string | null {
  switch (state) {
    case 'preparing': return t('row.preparing')
    case 'running': return t('bash.running')
    case 'error': return t('bash.failed')
    case 'stopped': return t('bash.stopped')
    default: return null
  }
}

/**
 * Render expandable Bash output with an accessible lifecycle label. While the
 * call is preparing the row shows the description streamed so far and cannot expand.
 * @param props - tool call, Session sources, locale, and inspection callback.
 * @returns the Bash output row.
 */
export const BashRow = memo(function BashRow({
  toolName, block, sessionId, useSessions, inspect, useDisclosure, t, renderToolRow,
}: BashRowProps) {
  const model = useMemo(() => toolRowModel(toolName, block), [toolName, block])
  // An omitted shell workdir is the session workspace; relative values resolve
  // against it before reaching the terminal primitive.
  const cwd = useSessions(list => list.byId[sessionId]?.cwd)
  const terminalModel = useMemo(() => terminalCardModel(block, cwd), [block, cwd])
  const terminal = useMemo(() => terminalModel === null ? null : localizeTerminalCardModel(terminalModel, t), [terminalModel, t])
  const labels = useMemo(() => terminalBlockLabels(t), [t])
  // Exit failures are result data even when the tool call itself succeeds.
  const state = model.state === 'ok' && terminalModel !== null && terminalFailed(terminalModel)
    ? 'error'
    : model.state
  const status = stateStatus(state, t)
  const { expanded, toggle: toggleExpand } = useDisclosure()
  const background = isBackgroundShellCall(block)
  const hasBody = model.bodyRaw !== null || model.output !== null
  // Every dispatched shell keeps its plain-text input and output reachable:
  // without a terminal card, the row itself is the disclosure. Preparation is
  // the one stage that stays collapsed, because the call is still streaming.
  const genericBody = terminal === null && hasBody && model.state !== 'preparing'
  const expandable = terminal !== null || genericBody
  const open = expanded && expandable
  const normalSummary = terminal?.description ?? model.summary
  const exitLabel = terminalExitLabel(terminalModel, t)
  const settlementLine = exitLabel !== null ? null : state === 'error'
    ? model.errorSummary ?? normalSummary
    : state === 'stopped' ? t('bash.stopped') : null
  const summaryText = settlementLine ?? normalSummary
  const running = state === 'running' || state === 'preparing'
  const toggleFromKeyboard = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    toggleExpand()
  }, [expandable, toggleExpand])
  const leading = open
    ? <IconChevronUpOutlineRegular className={css.chevron} />
    : expandable
      ? (
        <>
          <span className={css.iconIdle}>{BASH_ICON}</span>
          <IconChevronDownOutlineRegular className={clsx(css.chevron, css.chevronHover)} />
        </>
      )
      : BASH_ICON
  // The slot occupant owns the collapsed header; this body stays available
  // through `renderBody` even while its own header shows a different state.
  const renderBody = (): ReactNode => {
    const body = genericBody && model.bodyRaw !== null ? formatToolBody(model.variant, model.bodyRaw) : null
    return (
      <div className={css.bodyWrap}>
        {terminal !== null
          ? (
            <TerminalBlock
              {...terminal.card}
              maxLines={Infinity}
              labels={labels}
              className={css.terminal}
            />
          )
          : (
            <div className={css.ioCard}>
              {body !== null && (
                <div className={css.ioSection}>
                  <span className={css.ioLabel}>{t('row.input')}</span>
                  {background
                    ? <CommandText className={css.commandInput} text={body} label={t('row.commandArguments')} />
                    : <span className={css.ioText}>{body}</span>}
                </div>
              )}
              {body !== null && model.output !== null && (
                <span className={css.ioDivider} aria-hidden />
              )}
              {model.output !== null && (
                <div className={css.ioSection}>
                  <span className={css.ioLabel}>{t('row.output')}</span>
                  <span className={css.ioText} data-error={state === 'error' || undefined}>
                    {model.output}
                  </span>
                </div>
              )}
            </div>
          )}
        {inspect !== undefined && (
          <button type="button" className={css.inspectButton} onClick={inspect}>
            <IconInspectOutlineRegular />
            {t('row.inspect')}
          </button>
        )}
      </div>
    )
  }
  const renderDefault = (): ReactNode => (
    <div className={css.card}>
      <div
        className={css.root}
        data-sample="bash"
        data-variant="bash"
        data-state={state}
        data-expandable={expandable || undefined}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={expandable ? toggleExpand : undefined}
        onKeyDown={expandable ? toggleFromKeyboard : undefined}
      >
        <span className={css.leading}>{leading}</span>
        {status !== null && <span className={css.visuallyHidden}>{status}</span>}
        <TextShimmer active={running}>
          <TextShimmer className={css.title}>{t(model.titleKey)}</TextShimmer>
          {summaryText !== '' && (
            <>
              <span className={css.sep} data-shimmer-decoration aria-hidden />
              <span className={clsx(
                css.summary,
                exitLabel === null && state === 'error' && css.errorSummary,
                exitLabel === null && state === 'stopped' && css.stoppedSummary,
              )}>
                <TextShimmer>{summaryText}</TextShimmer>
              </span>
            </>
          )}
          {exitLabel !== null && <ExitCodeBadge label={exitLabel} />}
        </TextShimmer>
      </div>
      {open && renderBody()}
    </div>
  )
  if (renderToolRow === undefined) return renderDefault()
  return renderToolRow({
    t,
    variant: 'bash',
    toolName,
    icon: BASH_ICON,
    title: t(model.titleKey),
    intent: model.intent,
    summary: summaryText,
    state,
    useDisclosure,
    inspect,
    expandable,
    renderBody,
    renderDefault,
  }, renderDefault())
})

/** Registers the standalone Bash conversation-row sample. */
export const bashToolviewSample = {
  name: 'bash-toolview-sample',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register({ name: 'tool.call.toolview', key: 'bash', locale: NS }, BashRow))
  },
}
