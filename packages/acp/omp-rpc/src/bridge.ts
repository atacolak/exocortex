import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStepStream } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { OmpModelCatalogSync, type CatalogSyncOutcome, type OmpModelSelection } from './catalog.ts'
import { OmpRpcClient } from './client.ts'
import { DEFAULT_OMP_HOST_TOOLS, ompCordisHostTools } from './cordis-tools.ts'
import { OmpAgentDriver, type OmpImageInput, type OmpImageRef, type OmpToolEvent } from './driver.ts'
import { OmpHostToolBridge } from './host-tools.ts'
import { launchOmp, type LaunchedOmp } from './launch.ts'
import { OmpUiBridge, type OmpUiAsker } from './ui.ts'
import type { OmpExtensionUiRequest, OmpRpcCommand } from './types.ts'

/** How a harness agent joins an OMP process. */
export type OmpAttachMode = 'attach' | 'fork'

/** One attach or fork request. */
export interface OmpAttachOptions {
  readonly mode: OmpAttachMode
  /** Profile name passed as `--agent`; omitted uses OMP's default profile. */
  readonly preset?: string
  /** Existing OMP transcript for `attach`; omitted starts a fresh transcript. */
  readonly sessionId?: string
  /** Exact transcript path to resume for `attach`; wins over {@link sessionId}. */
  readonly resumePath?: string
  /** Existing transcript path to copy for `fork`; omitted replays harness history instead. */
  readonly forkPath?: string
  /** Provider/model the OMP gateway should serve for this attachment. */
  readonly selection?: OmpModelSelection
  /** Directory holding OMP transcripts for this attachment. */
  readonly sessionDir: string
  /** Harness tools published to OMP; defaults to the Cordis discovery set. */
  readonly hostTools?: readonly string[]
  /** Working directory for the OMP process. */
  readonly cwd: string
}

/** What one successful attachment exposes to callers. */
export interface OmpAttachment {
  readonly client: OmpRpcClient
  readonly launched: LaunchedOmp
  readonly catalog: CatalogSyncOutcome
  /** Session identity and transcript path OMP reports as active. */
  readonly session: { readonly id: string; readonly path?: string }
  /** Working directory the OMP process was launched in. */
  readonly cwd: string
}

async function activeSessionOf(client: OmpRpcClient): Promise<OmpAttachment['session']> {
  const state = await client.request({ type: 'get_state' })
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    throw new Error('OMP get_state returned no session state')
  }
  const record = state as Record<string, unknown>
  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) {
    throw new Error('OMP get_state returned no session id')
  }
  return {
    id: record.sessionId,
    ...typeof record.sessionFile === 'string' && record.sessionFile.length > 0
      ? { path: record.sessionFile }
      : {},
  }
}

/** Collaborators shared by every attachment in one bridge plugin. */
export interface OmpBridgeOptions {
  readonly ctx: Context
  readonly subprocess: SubprocessRuntime
  /** OMP executable name or absolute path resolved by the subprocess provider. */
  readonly executable: string
  readonly asker?: OmpUiAsker
  readonly onSurface?: (request: OmpExtensionUiRequest) => void
}

/** A profile typed into `/omp-attach` or `/omp-fork`. */
export interface OmpCommandInput {
  readonly preset?: string
  readonly sessionId?: string
}

/** Parse the optional `<preset> [session]` argument grammar. */
export function parseOmpCommandInput(rawInput: string): OmpCommandInput {
  const [preset, sessionId, ...rest] = rawInput.trim().split(/\s+/u).filter(token => token.length > 0)
  if (rest.length > 0) throw new Error('expected at most two arguments: <preset> [session]')
  return {
    ...preset === undefined ? {} : { preset },
    ...sessionId === undefined ? {} : { sessionId },
  }
}

/**
 * Build the OMP RPC argv for one attachment. Fork starts a fresh transcript so
 * the harness history is replayed into it; attach resumes an explicitly named
 * transcript, and starts a fresh one in the shared OMP root when none is named.
 * @param options - executable, mode, profile, and transcript directory.
 * @returns argv beginning with the OMP executable.
 */
export function ompLaunchArgv(options: {
  readonly executable: string
  readonly mode: OmpAttachMode
  readonly sessionDir: string
  readonly preset?: string
  readonly sessionId?: string
  readonly resumePath?: string
  readonly forkPath?: string
}): string[] {
  const argv = [options.executable, '--mode', 'rpc', '--session-dir', options.sessionDir]
  if (options.preset !== undefined) argv.push('--agent', options.preset)
  if (options.mode === 'attach') {
    if (options.resumePath !== undefined) argv.push('--resume', options.resumePath)
    else if (options.sessionId !== undefined) argv.push('--resume', options.sessionId)
  } else if (options.forkPath !== undefined) {
    argv.push('--fork', options.forkPath)
  }
  return argv
}

interface LiveAttachment {
  readonly agent: Agent
  readonly launched: LaunchedOmp
  readonly driver: OmpAgentDriver
  readonly hostTools: OmpHostToolBridge
  readonly ui: OmpUiBridge
  readonly pendingTools: OmpToolEvent[]
  readonly disposeCommands: () => void
  detachStream: () => void
  readonly cursor: LiveCursor
}

interface LiveCursor {
  readonly agent: Agent
  turn: number
  step: number
}

/**
 * Owns the OMP processes attached to harness agents. One attachment serves
 * every step of its agent through `agent/step-stream`, publishes host tools,
 * answers extension UI, projects OMP's internal tool executions into the
 * trajectory, and closes with the agent's scope.
 */
export class OmpBridge {
  private readonly options: OmpBridgeOptions
  private readonly attachments = new Map<SessionId, LiveAttachment>()

  constructor(options: OmpBridgeOptions) {
    this.options = options
  }

  /**
   * Start or resume one OMP process and bind it to an agent.
   * @param agent - the live harness agent to serve.
   * @param options - attach/fork mode, transcript identity, and launch inputs.
   * @returns the launched process and the catalog synchronization outcome.
   */
  async attach(agent: Agent, options: OmpAttachOptions): Promise<OmpAttachment> {
    await this.detach(agent.id)
    await mkdir(options.sessionDir, { recursive: true })
    const executable = await this.options.subprocess.resolveExecutable(this.options.executable, undefined)
    const launched = launchOmp(this.options.subprocess, {
      argv: ompLaunchArgv({ ...options, executable }),
      cwd: options.cwd,
      env: { EXOCORTEX_ENV: '1' },
    })
    let client: OmpRpcClient | undefined
    try {
      await launched.ready
      client = launched.client
      await client.negotiateProtocol()
      const session = await activeSessionOf(client)
      const selection = options.selection ?? agent.model.current()
      const catalog = await new OmpModelCatalogSync(client, selection).sync()
      const hostTools = new OmpHostToolBridge({
        client,
        tools: () => ompCordisHostTools({
          ctx: this.options.ctx,
          agent,
          names: options.hostTools ?? DEFAULT_OMP_HOST_TOOLS,
        }),
      })
      const ui = new OmpUiBridge({
        client,
        asker: this.options.asker ?? (() => Promise.resolve({ type: 'extension_ui_response', id: '', cancelled: true } as const)),
        ...this.options.onSurface === undefined ? {} : { onSurface: this.options.onSurface },
      })
      const cursor = { agent, turn: 0, step: 0 }
      const pendingTools: OmpToolEvent[] = []
      const driver = new OmpAgentDriver(client, {
        transcript: options.mode === 'fork' && options.forkPath === undefined ? 'replay' : 'latest',
        resolveImages: refs => this.readImages(refs),
        onTool: (events) => { pendingTools.push(...events) },
        onContinue: () => { this.continueTurn(agent) },
      })
      const live: LiveAttachment = {
        agent,
        launched,
        driver,
        hostTools,
        ui,
        pendingTools,
        disposeCommands: this.registerCommands(agent, client),
        detachStream: () => {},
        cursor,
      }
      live.detachStream = this.bindStream(live)
      await hostTools.sync()
      this.attachments.set(agent.id, live)
      agent.ctx.effect(() => () => this.detach(agent.id), 'omp-rpc attachment')
      return { client, launched, catalog, session, cwd: options.cwd }
    } catch (error: unknown) {
      await launched.close()
      throw error
    }
  }

  /**
   * Whether one harness session already has a live OMP process bound to it.
   * @param id - harness session identity.
   * @returns true while an attachment is registered.
   */
  attached(id: SessionId): boolean {
    return this.attachments.has(id)
  }

  /**
   * Stop the OMP process attached to one session.
   * @param id - harness session identity.
   */
  async detach(id: SessionId): Promise<void> {
    const live = this.attachments.get(id)
    if (live === undefined) return
    this.attachments.delete(id)
    live.detachStream()
    live.disposeCommands()
    live.hostTools.close()
    live.ui.close()
    await live.launched.close()
  }

  /** Stop every attachment, as when the owning plugin unloads. */
  async dispose(): Promise<void> {
    await Promise.all([...this.attachments.keys()].map(id => this.detach(id)))
  }

  private bindStream(live: LiveAttachment): () => void {
    const stopStep = live.agent.ctx.on('agent/step-stream', async (payload, next) => {
      if (payload.agent !== live.agent) return next()
      live.cursor.turn = payload.turn
      live.cursor.step = payload.step
      const stream: AgentStepStream = (request, signal) => live.driver.stream(request, signal)
      return stream
    })
    const stopAssistant = live.agent.ctx.on('agent/assistant-stream', (payload) => {
      const frame = payload.frame
      if (frame.type !== 'end') return
      if (frame.outcome.kind !== 'committed' || frame.outcome.eventType !== 'assistant/message') {
        live.pendingTools.length = 0
        return
      }
      const tools = live.pendingTools.splice(0)
      for (const event of tools) this.projectTool(live.cursor, event)
    })
    return () => {
      stopStep()
      stopAssistant()
    }
  }

  private async readImages(refs: readonly OmpImageRef[]): Promise<OmpImageInput[]> {
    const attachments = this.options.ctx.attachments
    if (attachments === undefined) throw new Error('OMP prompt contains images but the attachment service is not mounted')
    const images: OmpImageInput[] = []
    for (const ref of refs) {
      const stored = await attachments.readImage(ref)
      images.push({ data: Buffer.from(stored.data).toString('base64'), mimeType: ref.mediaType })
    }
    return images
  }

  private continueTurn(agent: Agent): void {
    agent.inbox.append('next-step', createUserMessage({
      content: [{ type: 'text', text: 'omp:continue' }],
      source: { kind: 'runtime-context' },
    }))
  }

  private registerCommands(agent: Agent, client: OmpRpcClient): () => void {
    const disposers = [
      agent.ctx.commands.register({
        name: 'compact',
        description: 'Compact the attached OMP session natively, preserving its own summary and transcript.',
        input: { hint: '[instructions]' },
        async handler(invocation) {
          const instructions = invocation.rawInput.trim()
          try {
            const result = await client.request({
              type: 'compact',
              ...instructions.length === 0 ? {} : { customInstructions: instructions },
            } as unknown as OmpRpcCommand)
            const tokens = objectOf(result)?.tokensBefore
            const before = typeof tokens === 'number' ? ` (${String(tokens)} tokens before)` : ''
            return { kind: 'success', text: `Compacted OMP context${before}.` }
          } catch (error: unknown) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        },
      }),
      agent.ctx.commands.register({
        name: 'omp',
        description: 'Run a native OMP slash command (for example `/omp status`) in the attached session.',
        input: { hint: '<command> [args]' },
        async handler(invocation) {
          const line = invocation.rawInput.trim()
          if (line.length === 0) return { kind: 'error', text: 'expected an OMP slash command' }
          try {
            return { kind: 'success', text: await runOmpCommand(client, line, invocation.signal) }
          } catch (error: unknown) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        },
      }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }

  private projectTool(cursor: LiveCursor, event: OmpToolEvent): void {
    const callId = ToolCallId(event.toolCallId)
    if (event.kind === 'start') {
      cursor.agent.session.append('tool/call', {
        turn: cursor.turn,
        step: cursor.step,
        callId,
        name: event.toolName,
        arguments: JSON.stringify(event.arguments),
      })
      return
    }
    const content = event.content.map(block => block.type === 'image'
      ? { type: 'text' as const, text: `[image: ${block.mimeType ?? 'unknown'}]` }
      : { type: 'text' as const, text: block.text ?? '' })
    cursor.agent.session.append('tool/result', {
      turn: cursor.turn,
      step: cursor.step,
      message: createToolResultMessage({ callId, content, isError: event.isError }),
    }, { surfaceOp: 'append' })
  }
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * Run one native OMP slash command through the RPC prompt queue and collect
 * the command output it prints before settling.
 * @param client - the attached OMP process.
 * @param commandLine - the slash command text, without a leading harness slash.
 * @param signal - cancellation for the command.
 * @returns the command's printed output.
 */
export async function runOmpCommand(
  client: Pick<OmpRpcClient, 'request' | 'onFrame'>,
  commandLine: string,
  signal: AbortSignal,
): Promise<string> {
  const outputs: string[] = []
  const { promise, resolve } = Promise.withResolvers<{ status: string; message?: string }>()
  let settled = false
  const stop = client.onFrame((frame) => {
    if (frame.type === 'command_output' && typeof frame.text === 'string') outputs.push(frame.text)
    if (frame.type !== 'prompt_result') return
    settled = true
    resolve({
      status: frame.status,
      ...frame.error?.message === undefined ? {} : { message: frame.error.message },
    })
  })
  const abort = (): void => {
    void client.request({ type: 'abort' }).catch(() => {})
    if (settled) return
    settled = true
    resolve({ status: 'aborted' })
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const response = await client.request({ type: 'prompt', message: commandLine } as unknown as OmpRpcCommand)
    if (objectOf(response)?.agentInvoked === false) return outputs.join('')
    const result = await promise
    if (result.status === 'error') throw new Error(result.message ?? 'OMP command failed')
    if (result.status === 'aborted') throw new Error('OMP command was aborted')
    return outputs.join('')
  } finally {
    stop()
    signal.removeEventListener('abort', abort)
  }
}

