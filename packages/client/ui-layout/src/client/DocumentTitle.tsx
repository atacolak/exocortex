/** Browser title selection follows the active main panel without subscribing the frame. */
import { useEffect } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Props for the browser title projection. */
export type DocumentTitleProps = Pick<PropsRuntime<'root'>, 'useSessions' | 'usePanelInfo'> & {
  /** Build-configured or localized product title. */
  productTitle: string
}

const PRIVATE_USE_GLYPHS = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]\s*/gu

/**
 * Browser chrome never loads the page font, so a NerdFont glyph in a session
 * title renders as a hex tofu box in the tab. Keep the glyph in the page DOM
 * and strip it only from the OS-facing document title.
 * @param title - Durable session title as rendered in the header.
 * @returns The title with private-use glyphs and their trailing spacing removed.
 */
export function browserTitleText(title: string): string {
  return title.replace(PRIVATE_USE_GLYPHS, '')
}

/**
 * Project the selected durable session title into the browser title and
 * restore the build-selected product title when unmounted.
 * @param props - Selected session title projection.
 * @returns No rendered content.
 */
export function DocumentTitle({ useSessions, usePanelInfo, productTitle }: DocumentTitleProps): null {
  const showSessionTitle = usePanelInfo(info => info.activePanelId === null)
  const title = useSessions((state) => {
    const current = Object.values(state.byId)
      .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
    return !showSessionTitle || current === undefined ? undefined : state.byId[current]?.title
  })
  useEffect(() => {
    const visible = title === undefined ? '' : browserTitleText(title)
    document.title = visible.trim() === '' ? productTitle : `${visible} — ${productTitle}`
    return () => { document.title = productTitle }
  }, [productTitle, title])
  return null
}
