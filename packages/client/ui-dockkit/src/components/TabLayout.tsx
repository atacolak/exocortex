/** Stable tab siblings in one horizontal Grid, including viewport-positioned floats. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MutableRefObject, ReactNode } from 'react'
import clsx from 'clsx'
import type { DockIntents } from '../contract/adapter.ts'
import type { LayoutState, NodeId, PaneId, PaneNode, SplitAxis, SplitId, TabId, TabRecord } from '../contract/types.ts'
import { findTabPane, floatRect, getNode, getPane } from '../engine/tree.ts'
import type { SizePreview } from './PaneTree.tsx'
import type { PaneCallbacks } from './render.ts'
import { FloatHeader, floatStyle, useFloatGestures } from './FloatLayer.tsx'
import { TabBody } from './TabBody.tsx'
import { PaneDropHints, TabPanel, TabStrip } from './TabPanel.tsx'
import css from './dockkit.module.css'

/** Host policy for lazily retaining a tab body without reparenting it. */
export interface TabRetention {
  /** Whether a visited body survives hiding; omitted means visibility-mounted. */
  readonly keepMounted?: (tab: TabRecord) => boolean
  /** Whether this layout's Session is on screen; defaults to true. */
  readonly active?: boolean
}

interface LayoutProps extends TabRetention {
  readonly state: LayoutState
  readonly callbacks: PaneCallbacks
  readonly preview: SizePreview | undefined
  readonly intents: DockIntents
}

/** One docked pane's box as fractions of the layout. */
interface DockSlot {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** One split boundary's box as fractions of the layout. */
interface DividerSlot extends DockSlot {
  readonly splitId: SplitId
  readonly index: number
  readonly axis: SplitAxis
}

/**
 * Flatten the docked tree into pane boxes and split boundaries.
 * @param state - committed layout.
 * @param preview - live divider fractions, if a drag is in progress.
 * @returns every docked pane's box and every divider's line, in tree order.
 */
function slotsOf(state: LayoutState, preview: SizePreview | undefined): {
  readonly panes: ReadonlyMap<PaneId, DockSlot>
  readonly dividers: readonly DividerSlot[]
} {
  const panes = new Map<PaneId, DockSlot>()
  const dividers: DividerSlot[] = []
  const walk = (nodeId: NodeId, slot: DockSlot): void => {
    const node = getNode(state, nodeId)
    if (node.kind === 'pane') { panes.set(node.id, slot); return }
    const sizes = preview?.splitId === node.id ? preview.sizes : node.sizes
    let offset = 0
    node.children.forEach((childId, index) => {
      const size = sizes[index] ?? 0
      const start = node.axis === 'row' ? slot.left + slot.width * offset : slot.top + slot.height * offset
      if (index > 0) {
        dividers.push(node.axis === 'row'
          ? { splitId: node.id, index: index - 1, axis: node.axis, left: start, top: slot.top, width: 0, height: slot.height }
          : { splitId: node.id, index: index - 1, axis: node.axis, left: slot.left, top: start, width: slot.width, height: 0 })
      }
      walk(childId, node.axis === 'row'
        ? { left: start, top: slot.top, width: slot.width * size, height: slot.height }
        : { left: slot.left, top: start, width: slot.width, height: slot.height * size })
      offset += size
    })
  }
  walk(state.rootId, { left: 0, top: 0, width: 1, height: 1 })
  return { panes, dividers }
}

/** Inline placement for one fractional box. */
function slotStyle(slot: DockSlot): { left: string; top: string; width: string; height: string } {
  return {
    left: `${slot.left * 100}%`,
    top: `${slot.top * 100}%`,
    width: `${slot.width * 100}%`,
    height: `${slot.height * 100}%`,
  }
}

interface TabHostProps extends LayoutProps {
  readonly tab: TabRecord
  readonly pane: PaneNode
  readonly slot: DockSlot | undefined
  readonly column: number | undefined
  readonly row: number | undefined
  readonly floats: ReturnType<typeof useFloatGestures>
  readonly focusRequest: MutableRefObject<{ readonly tabId: TabId; readonly origin: Element | null } | undefined>
  /** Chip-box offsets by pane, read and recorded by each selected tab's strip. */
  readonly offsets: Map<PaneId, number>
}

/** A tab's ancestors stay identical across selection, pane moves and floating. */
function TabHost({ state, callbacks, intents, tab, pane, slot, column, row, floats, focusRequest, offsets,
  keepMounted, active = true }: TabHostProps): ReactNode {
  const floating = pane.host === 'float'
  const selected = floating || pane.activeTabId === tab.id
  const visible = active && selected && (floating || state.expanded)
  const retained = keepMounted?.(tab) ?? false
  const [visited, setVisited] = useState(visible)
  if (visible && !visited) setVisited(true)
  const host = useRef<HTMLElement | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    // Both refs target unconditional descendants attached before these effects.
    const section = host.current as HTMLElement
    section.inert = !visible
    const focused = document.activeElement
    if (!visible && focused instanceof HTMLElement && section.contains(focused)) focused.blur()
    const request = focusRequest.current
    if (!visible || request?.tabId !== tab.id) return
    focusRequest.current = undefined
    // Preserve deliberate focus taken by another control or the newly shown body.
    if (focused !== null && focused !== document.body && focused !== document.documentElement && focused !== request.origin) return
    const strip = section.querySelector('[data-dockkit-strip]')
    const chip = [...strip?.querySelectorAll<HTMLElement>('[data-dockkit-tab]') ?? []]
      .find(element => element.dataset.dockkitTab === tab.id)
    chip?.focus({ preventScroll: true })
  }, [visible, tab.id, focusRequest])
  // Electron emits a non-bubbling focus event on the webview element.
  useEffect(() => {
    const element = body.current as HTMLDivElement
    const focus = (): void => {
      if (!visible) return
      if (floating) floats.raise(pane.id)
      else if (state.activePaneId !== pane.id) callbacks.onFocusPane(pane.id)
    }
    element.addEventListener('focus', focus, true)
    return () => { element.removeEventListener('focus', focus, true) }
  }, [visible, floating, floats, pane.id, state.activePaneId, callbacks])
  const lifted = floating && floats.preview?.paneId === pane.id ? floats.preview.rect : undefined
  const rect = floating ? floats.rectOf(pane.id, floatRect(pane)) : undefined
  const depth = lifted === undefined ? state.floats.indexOf(pane.id) + 1 : state.floats.length + 1
  return (
    <div className={clsx(css.tabCell, floating && css.floatingCell)} hidden={!selected}
      data-dockkit-host={floating ? 'float' : 'dock'}
      data-dockkit-column={floating ? undefined : column} data-dockkit-row={floating ? undefined : row}
      style={floating
        ? { zIndex: `calc(var(--dsh-dockkit-float-layer, 60) + ${depth})` }
        : slotStyle(slot as DockSlot)}>
      <section ref={host} tabIndex={-1} className={clsx(css.tabHost, floating ? css.float : css.pane)}
        aria-hidden={!visible || undefined}
        data-dockkit-content={tab.id}
        data-dockkit-pane={!floating && selected ? pane.id : undefined}
        data-dockkit-pane-active={!floating && state.activePaneId === pane.id || undefined}
        data-dockkit-float={floating ? pane.id : undefined}
        data-dockkit-float-active={floating && state.activePaneId === pane.id || undefined}
        data-dockkit-column={!floating ? column : undefined}
        data-dockkit-row={!floating ? row : undefined}
        style={rect === undefined ? undefined : floatStyle(rect, lifted !== undefined)}
        onPointerDown={() => { if (floating) floats.raise(pane.id) }}
        onClick={() => { if (!floating && state.activePaneId !== pane.id) callbacks.onFocusPane(pane.id) }}>
        <div className={css.tabHostHeader}>
          {selected && (floating
            ? <FloatHeader paneId={pane.id} tab={tab} labels={callbacks.labels} intents={intents}
              renderTabTitle={callbacks.renderTabTitle} canCloseTab={callbacks.canCloseTab} drag={floats.drag} />
            : <TabStrip state={state} pane={pane} callbacks={callbacks} offsets={offsets} />)}
        </div>
        <div ref={body} className={clsx(css.tabHostBody, floating ? css.floatBody : css.paneBody)}>
          {visited && (retained || (active && selected)) ? <TabBody tab={tab} renderTab={callbacks.renderTab} /> : null}
          {!floating && <PaneDropHints pane={pane} callbacks={callbacks} />}
        </div>
        {floating && <div className={css.floatResize} data-dockkit-float-resize={pane.id}
          onPointerDown={(event) => { floats.drag('resize', pane.id, event) }} />}
      </section>
    </div>
  )
}

/**
 * A recursive split tree with stable tab containers across pane moves and floats.
 * @param props - committed layout, gesture preview and body retention policy.
 * @returns stable tab containers positioned over every docked pane, including floating tabs.
 */
export function TabLayout(props: LayoutProps): ReactNode {
  const { state, callbacks, preview } = props
  const focusRequest = useRef<{ readonly tabId: TabId; readonly origin: Element | null }>()
  // Each pane's strip remounts under the newly selected tab's host.
  const [offsets] = useState(() => new Map<PaneId, number>())
  const tabCallbacks: PaneCallbacks = {
    ...callbacks,
    onFocusTab: (tabId) => {
      // Only changing the selected body replaces its strip; pane-only focus does not.
      focusRequest.current = findTabPane(state, tabId).activeTabId === tabId
        ? undefined : { tabId, origin: document.activeElement }
      callbacks.onFocusTab(tabId)
    },
  }
  const { panes: slots, dividers } = slotsOf(state, preview)
  const floats = useFloatGestures(state, props.intents)
  const root = getNode(state, state.rootId)
  const columnOf = (slot: DockSlot): number => slot.left === 0 ? 0 : 1
  const rowOf = (slot: DockSlot): number => slot.top === 0 ? 0 : 1
  return (
    <div className={css.tabLayout} data-dockkit-split={root.kind === 'split' ? root.id : undefined}>
      {/* Logical order changes must not make React move a connected webview's ancestor. */}
      {Object.values(state.tabs).sort((a, b) => a.id.localeCompare(b.id)).map((tab) => {
        const pane = findTabPane(state, tab.id)
        const slot = pane.host === 'float' ? undefined : slots.get(pane.id)
        return <TabHost key={tab.id} {...props} callbacks={tabCallbacks} tab={tab} pane={pane}
          slot={slot} column={slot === undefined ? undefined : columnOf(slot)}
          row={slot === undefined ? undefined : rowOf(slot)}
          floats={floats} focusRequest={focusRequest} offsets={offsets} />
      })}
      {[...slots].map(([id, slot]) => {
        const pane = getPane(state, id)
        return pane.tabs.length === 0
          ? <div key={pane.id} className={css.emptyTabHost} data-dockkit-empty
            data-dockkit-column={columnOf(slot)} data-dockkit-row={rowOf(slot)} style={slotStyle(slot)}>
            <TabPanel state={state} pane={pane} callbacks={callbacks} />
          </div>
          : null
      })}
      {dividers.map(divider => (
        <div key={`${divider.splitId}:${divider.index}`} className={clsx(css.divider, css.tabLayoutDivider)}
          data-dockkit-divider={`${divider.splitId}:${divider.index}`} data-dockkit-axis={divider.axis}
          style={slotStyle(divider)}
          onPointerDown={(event) => { callbacks.onDividerPressed(divider.splitId, divider.index, event) }} />
      ))}
    </div>
  )
}
