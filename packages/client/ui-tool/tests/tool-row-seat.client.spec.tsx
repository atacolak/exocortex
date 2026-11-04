// @vitest-environment jsdom

import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { StartedToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import type { ToolRowSlotProps } from '../src/client/contract/slots.ts'
import { GenericToolCard, type GenericToolCardProps } from '../src/client/tool/toolviews/GenericToolCard.tsx'
import { BashRow } from '../src/client/tool/toolviews/bash-sample.tsx'

type BashRowProps = Parameters<typeof BashRow>[0]

const t: GenericToolCardProps['t'] = makeTranslate(zh, commonZh)
const SID = 'root-1' as SessionId

afterEach(cleanup)

function listStore() {
  return createSnapshotStore<SessionListState>({
    ids: [SID],
    byId: {
      [SID]: { id: SID, title: 'r', displayTitle: 'r', running: false, retainedBy: {}, blank: false, updatedAt: 0 },
    },
    phase: 'ready',
    projectionsBySession: {},
  })
}

const ARGS = JSON.stringify({ i: 'Run\n  focused  tests', command: 'npm test', description: 'Run the suite' })

const settled = (over: Partial<ToolResultNode> = {}): ToolResultNode => {
  const call = over.call === undefined ? { name: 'bash', argsRaw: ARGS } : over.call
  return {
    kind: 'tool-result', seq: 10, time: 2_000, callId: 'c1',
    name: call?.name ?? '', args: call === null ? PartialArguments.EMPTY : PartialArguments.fromText(call.argsRaw),
    call,
    callTime: 1_000,
    content: [{ type: 'text', text: 'a.ts  b.ts\nc.ts  d.ts\n' }], isError: false,
    subCalls: [], ...over,
  }
}

function bashProps(block: StartedToolCall | ToolResultNode, renderToolRow?: BashRowProps['renderToolRow']): BashRowProps {
  return {
    useDisclosure,
    callId: 'c1',
    toolName: 'bash',
    ...('kind' in block ? { phase: 'result' as const, block } : { phase: block.phase, block }),
    openFile: vi.fn(),
    sessionId: SID,
    useSessions: bindSnapshotSelector(listStore()),
    t,
    ...renderToolRow === undefined ? {} : { renderToolRow },
  } as BashRowProps
}

function ownerProps(block: StartedToolCall | ToolResultNode, renderToolRow?: GenericToolCardProps['renderToolRow']): GenericToolCardProps {
  return {
    useDisclosure,
    callId: 'c1',
    toolName: 'bash',
    ...('kind' in block ? { phase: 'result' as const, block } : { phase: block.phase, block }),
    openFile: vi.fn(),
    getFileTriggerProps: () => ({}),
    loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
    t,
    ...renderToolRow === undefined ? {} : { renderToolRow },
  } as GenericToolCardProps
}

/** Occupant-shaped probe: its own header, then the stock body only while expanded. */
function occupantProbe(seat: { current: ToolRowSlotProps | undefined }) {
  return function Occupant(props: ToolRowSlotProps) {
    seat.current = props
    const { expanded, toggle } = props.useDisclosure()
    return (
      <div data-testid="tool-row-occupant">
        <button type="button" onClick={toggle}>{expanded ? 'collapse' : 'expand'}</button>
        {expanded && props.renderBody?.()}
      </div>
    )
  }
}

describe('tool.row seat', () => {
  it('BashRow hands bash calls to the registered row occupant with intent and expandable body', () => {
    const seat: { current: ToolRowSlotProps | undefined } = { current: undefined }
    const renderToolRow = vi.fn((props: ToolRowSlotProps, fallback: ReactNode) => {
      void fallback
      const Occupant = occupantProbe(seat)
      return <Occupant {...props} />
    })
    const view = render(<BashRow {...bashProps(settled(), renderToolRow)} />)

    expect(renderToolRow).toHaveBeenCalledTimes(1)
    expect(seat.current).toMatchObject({
      toolName: 'bash',
      intent: 'Run focused tests',
      state: 'ok',
      expandable: true,
    })
    expect(typeof seat.current?.renderBody).toBe('function')
    expect(typeof seat.current?.renderDefault).toBe('function')
    // The occupant owns the header now: no stock bash header renders beside it.
    expect(view.queryByText('运行命令')).toBeNull()
    expect(view.getByTestId('tool-row-occupant')).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: 'expand' }))
    expect(view.queryByText('运行命令')).toBeNull()
    const body = seat.current!.renderBody!()
    const bodyView = render(<>{body}</>)
    const terminal = bodyView.container.querySelector('[data-terminal]')
    expect(terminal).not.toBeNull()
    expect(terminal?.textContent).toContain('a.ts')
    expect(bodyView.container.querySelector('[data-sample="bash"]')).toBeNull()
  })

  it('GenericToolCard rows expose the same seat facts, including renderBody without the stock header', () => {
    const seat: { current: ToolRowSlotProps | undefined } = { current: undefined }
    const renderToolRow = vi.fn((props: ToolRowSlotProps, fallback: ReactNode) => {
      void fallback
      const Occupant = occupantProbe(seat)
      return <Occupant {...props} />
    })
    const view = render(<GenericToolCard {...ownerProps(settled(), renderToolRow)} />)

    expect(renderToolRow).toHaveBeenCalledTimes(1)
    expect(seat.current).toMatchObject({
      toolName: 'bash',
      intent: 'Run focused tests',
      state: 'ok',
      expandable: true,
    })
    fireEvent.click(view.getByRole('button', { name: 'expand' }))
    expect(view.container.querySelector('[data-terminal]')?.textContent).toContain('a.ts')
    expect(view.container.querySelector('[data-sample="bash"]')).toBeNull()
    expect(view.queryByText('运行命令')).toBeNull()
  })

  it('keeps the stock BashRow when no occupant registers', () => {
    const view = render(<BashRow {...bashProps(settled())} />)
    expect(view.getByText('运行命令')).toBeTruthy()
    expect(view.getByText('Run the suite')).toBeTruthy()
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    expect(view.getByText('a.ts  b.ts', { normalizer: (text: string) => text })).toBeTruthy()
  })
})
