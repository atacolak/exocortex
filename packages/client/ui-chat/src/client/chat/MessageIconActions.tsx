// Shared IconActions chrome for user and assistant messages: copy
// live, a Retry/Branch more menu on settled answers, and an optional
// date-aware clock.

import { useState, type ReactNode } from 'react'
import {
  IconBranchOutlineRegular, IconCheckOutlineRegular, IconCopyOutlineRegular, IconEllipsisOutlineRegular,
  IconRefreshOutlineRegular, Menu, MenuItemButton, Tooltip, useClipboardCopy,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { formatMessageClock } from './message-chrome.ts'
import { useCalendarDay } from './use-calendar-day.ts'
import css from './MessageIconActions.module.css'

export interface MessageIconActionsProps {
  /** Plain text the copy action writes. */
  text: string
  /** Unix epoch ms for the clock label; omitted for transient messages. */
  time?: number | undefined
  /** Clock before icons (user) or after (assistant). */
  clock: 'start' | 'end'
  /** Fork the session at this message; omission hides the branch action. */
  onBranch?: (() => void) | undefined
  /** The message is not a completed transcript tail, so branch stays visible but unavailable. */
  branchUnavailable?: boolean | undefined
  /** Re-submit this Turn's user content; omission hides the retry action. */
  onRetry?: (() => void) | undefined
  /** Parent layout class composed onto the actions row. */
  className?: string | undefined
  /**
   * Slot-rendered actions owned by independent plugins, placed between the
   * built-in copy and more controls.
   */
  extraActions?: ReactNode
  /**
   * Icon-row Turn-usage trigger (the TurnUsagePanel pill), seated after the
   * more control at the end of the icon cluster.
   */
  usageAction?: ReactNode
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

/**
 * Copy / more (/ clock) IconActions row shared by user and assistant chrome.
 * @param props - Copy text, event time, clock side, retry and branch callbacks, className.
 * @returns The actions row element.
 */
export function MessageIconActions({
  text, time, clock, onBranch, branchUnavailable = false, onRetry, className,
  extraActions, usageAction, t,
}: MessageIconActionsProps) {
  const day = useCalendarDay()
  const [open, setOpen] = useState(false)
  const { copied, onCopy } = useClipboardCopy(text)
  const clockEl = time === undefined ? null : (
    <span className={clock === 'start' ? css.timeStart : css.timeEnd}>
      {formatMessageClock(time, t, day)}
    </span>
  )
  const close = (): void => { setOpen(false) }
  const hasMenu = onRetry !== undefined || onBranch !== undefined
  return (
    <div className={className === undefined ? css.actions : `${css.actions} ${className}`} data-clock={clock}>
      {clock === 'start' ? clockEl : null}
      <Tooltip label={copied ? t('copied') : t('copy')} side="bottom">
        <button type="button" className={css.action} aria-label={copied ? t('copied') : t('copy')} onClick={onCopy}>
          {copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
        </button>
      </Tooltip>
      {extraActions}
      {hasMenu && (
        <Menu
          open={open}
          onClose={close}
          portal
          autoFocus
          side="bottom"
          align="end"
          anchor={(
            <Tooltip label={t('message.actions')} side="bottom">
              <button
                type="button"
                className={css.action}
                aria-label={t('message.actions')}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => { setOpen(value => !value) }}
              >
                <IconEllipsisOutlineRegular />
              </button>
            </Tooltip>
          )}
        >
          {onRetry !== undefined && (
            <MenuItemButton icon={<IconRefreshOutlineRegular />} onSelect={() => {
              close()
              onRetry()
            }}>{t('message.retry')}</MenuItemButton>
          )}
          {onBranch !== undefined && (
            <MenuItemButton
              icon={<IconBranchOutlineRegular />}
              disabled={branchUnavailable}
              disabledReason={branchUnavailable ? t('message.branchUnavailable') : undefined}
              onSelect={() => {
                close()
                onBranch()
              }}
            >{t('message.branch')}</MenuItemButton>
          )}
        </Menu>
      )}
      {clock === 'end'
        ? <span className={css.endInfo}>{usageAction}{clockEl}</span>
        : usageAction}
    </div>
  )
}
