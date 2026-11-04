import { mkdir, stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStepStream } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import type { OmpBindings } from './bindings.ts'
import { OMP_THINKING_LEVELS, OmpModelCatalogSync, type CatalogSyncOutcome, type OmpModelSelection } from './catalog.ts'
import { OmpRpcClient } from './client.ts'
import { DEFAULT_OMP_HOST_TOOLS, ompCordisHostTools } from './cordis-tools.ts'
import { OmpAgentDriver, type OmpImageInput, type OmpImageRef, type OmpToolEvent } from './driver.ts'
import { OmpHostToolBridge } from './host-tools.ts'
import { launchOmp, type LaunchedOmp } from './launch.ts'
import { CLIENT_OWNED_COMMANDS, ompNativeCommandLine } from './native-commands.ts'
import { connectOmpSocket, type OmpSocketConnection } from './socket.ts'
import { OmpUiBridge, type OmpUiAsker } from './ui.ts'
import type { OmpExtensionUiRequest, OmpPromptResultFrame, OmpRpcCommand } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'omp-continue': { kind: 'omp-continue' }
  }
}

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
  /** Live session socket published by an OMP process this bridge must not own. */
  readonly socketPath?: string
}

/** What one successful attachment exposes to callers. */
export interface OmpAttachment {
  readonly client: OmpRpcClient
  /** Launched process this bridge owns; absent when attaching to a live socket. */
  readonly launched?: LaunchedOmp
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
  /** hcom extension mounted into every launch; omitted starts unregistered processes. */
  readonly hcomExtension?: string
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
 * @param options - executable, mode, profile, extension modules, and transcript directory.
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
  readonly extensions?: readonly string[]
}): string[] {
  const argv = [
    options.executable,
    ...(options.extensions ?? []).flatMap(extension => ['-e', extension]),
    '--mode', 'rpc', '--session-dir', options.sessionDir,
  ]
  if (options.preset !== undefined) argv.push('--agent', options.preset)
  if (options.mode === 'attach') {
    if (options.resumePath !== undefined) argv.push('--resume', options.resumePath)
    else if (options.sessionId !== undefined) argv.push('--resume', options.sessionId)
  } else if (options.forkPath !== undefined) {
    argv.push('--fork', options.forkPath)
  }
  return argv
}

/**
 * Environment every OMP RPC launch inherits. `EXOCORTEX_ENV` marks the process
 * as Exocortex-owned; the hcom extension binds identities only when the launch
 * carries `HCOM_LAUNCHED`.
 * @param options - whether the mounted extensions include the hcom binder.
 * @returns the environment additions for the OMP child process.
 */
export function ompLaunchEnvironment(options: { readonly hcom?: boolean } = {}): Record<string, string> {
  return {
    EXOCORTEX_ENV: '1',
    ...options.hcom === true ? { HCOM_LAUNCHED: '1' } : {},
  }
}

/** How one harness session joins an OMP transcript. */
export interface OmpAttachPlan {
  readonly mode: OmpAttachMode
  /** OMP session id to resume for `attach`. */
  readonly sessionId?: string
  /** Transcript path to resume for `attach`; wins over {@link sessionId}. */
  readonly resumePath?: string
  /** Parent transcript path to copy for `fork`. */
  readonly forkPath?: string
}

/** Convert OMP's todo phases into the whole-list snapshot DSH's TodoPanel records. */
export function ompTodoItems(state: unknown): TodoItem[] {
  const phases = objectOf(state)?.todoPhases
  if (!Array.isArray(phases)) return []
  const records = phases
    .map(objectOf)
    .filter((phase): phase is Record<string, unknown> => phase !== undefined)
  const multiple = records.length > 1
  const todos: TodoItem[] = []
  for (const record of records) {
    if (!Array.isArray(record.tasks)) continue
    const title = typeof record.name === 'string' && record.name.length > 0 ? record.name : undefined
    const phase = title !== undefined && (multiple || record.kind === 'passive') ? `[${title}] ` : ''
    for (const task of record.tasks) {
      const row = objectOf(task)
      if (row === undefined || typeof row.content !== 'string' || row.content.length === 0) continue
      const blocked = row.status === 'blocked' ? '[blocked] ' : ''
      todos.push({ content: `${phase}${blocked}${row.content}`, status: ompTodoStatus(row.status) })
    }
  }
  return todos
}

function ompTodoStatus(value: unknown): TodoItem['status'] {
  if (value === 'completed') return 'completed'
  if (value === 'in_progress') return 'in_progress'
  return 'pending'
}

interface OmpAvailableCommand {
  readonly name: string
  readonly description?: string
  readonly input?: { readonly hint?: string }
}

function ompAvailableCommands(value: unknown): OmpAvailableCommand[] {
  if (!Array.isArray(value)) return []
  const commands: OmpAvailableCommand[] = []
  for (const entry of value) {
    const record = objectOf(entry)
    const name = record?.name
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(name)) continue
    const description = typeof record?.description === 'string' ? record.description : undefined
    const hint = objectOf(record?.input)?.hint
    commands.push({
      name,
      ...description === undefined ? {} : { description },
      ...typeof hint === 'string' ? { input: { hint } } : {},
    })
  }
  return commands
}

async function existingFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined)
  return info?.isFile() === true
}

/**
 * Resolve how one harness session joins OMP: resume the transcript it already
 * owns, else fork the parent transcript recorded for a Branch child, else start
 * a fresh transcript. A recorded transcript is only usable while its file
 * remains on disk.
 * @param options - harness session identity and durable bindings.
 * @returns the attach or fork inputs for {@link OmpBridge.attach}.
 */
export async function planOmpAttach(options: {
  readonly sessionId: SessionId
  readonly bindings: Pick<OmpBindings, 'get' | 'getFork'>
}): Promise<OmpAttachPlan> {
  const own = await options.bindings.get(options.sessionId)
  if (own !== undefined && await existingFile(own.path)) {
    return { mode: 'attach', resumePath: own.path }
  }
  const fork = await options.bindings.getFork(options.sessionId)
  if (fork !== undefined && await existingFile(fork.forkFromPath)) {
    return { mode: 'fork', forkPath: fork.forkFromPath }
  }
  return { mode: 'attach' }
}

interface LiveAttachment {
  readonly agent: Agent
  readonly client: OmpRpcClient
  readonly launched?: LaunchedOmp
  readonly disconnect?: () => void
  /** OMP session identity this attachment serves, for duplicate-attach refusal. */
  readonly ompSessionId: string
  readonly driver: OmpAgentDriver
  readonly hostTools: OmpHostToolBridge
  readonly ui: OmpUiBridge
  readonly pendingTools: OmpToolEvent[]
  readonly disposeCommands: () => void
  detachStream: () => void
  readonly cursor: LiveCursor
  todos: TodoItem[]
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
  private readonly attachTails = new Map<SessionId, Promise<void>>()

  constructor(options: OmpBridgeOptions) {
    this.options = options
  }

  /**
   * Start or resume one OMP process and bind it to an agent.
   *
   * Attach and detach for one session serialize, so a watcher adopting a live
   * socket and an agent-created hook cannot both win the same session.
   * @param agent - the live harness agent to serve.
   * @param options - attach/fork mode, transcript identity, and launch inputs.
   * @returns the launched process and the catalog synchronization outcome.
   */
  attach(agent: Agent, options: OmpAttachOptions): Promise<OmpAttachment> {
    return this.enqueueAttach(agent.id, () => this.attachNow(agent, options))
  }

  /**
   * Whether one OMP session identity is already served by any attachment.
   * @param ompSessionId - session id recorded by the OMP transcript header.
   * @returns true while an attachment serves that OMP session.
   */
  servesOmpSession(ompSessionId: string): boolean {
    for (const live of this.attachments.values()) {
      if (live.ompSessionId === ompSessionId) return true
    }
    return false
  }

  private enqueueAttach<T>(id: SessionId, operation: () => Promise<T>): Promise<T> {
    const previous = this.attachTails.get(id) ?? Promise.resolve()
    const run = previous.then(operation, operation)
    this.attachTails.set(id, run.then(() => {}, () => {}))
    return run
  }

  private async attachNow(agent: Agent, options: OmpAttachOptions): Promise<OmpAttachment> {
    await this.detachNow(agent.id)
    let connection: OmpSocketConnection | undefined
    let launched: LaunchedOmp | undefined
    try {
      let client: OmpRpcClient
      if (options.socketPath === undefined) {
        await mkdir(options.sessionDir, { recursive: true })
        const executable = await this.options.subprocess.resolveExecutable(this.options.executable, undefined)
        const hcomExtension = this.options.hcomExtension !== undefined
          && await existingFile(this.options.hcomExtension)
          ? this.options.hcomExtension
          : undefined
        launched = launchOmp(this.options.subprocess, {
          argv: ompLaunchArgv({
            ...options,
            executable,
            ...hcomExtension === undefined ? {} : { extensions: [hcomExtension] },
          }),
          cwd: options.cwd,
          env: ompLaunchEnvironment({ hcom: hcomExtension !== undefined }),
        })
        await launched.ready
        client = launched.client
      } else {
        connection = await connectOmpSocket(options.socketPath)
        client = connection.client
      }
      await client.negotiateProtocol()
      const session = await activeSessionOf(client)
      if (options.sessionId !== undefined && session.id !== options.sessionId) {
        throw new Error(`OMP session socket ${options.socketPath ?? ''} serves session "${session.id}", not "${options.sessionId}"`)
      }
      const duplicate = [...this.attachments.values()].find(live => live.ompSessionId === session.id)
      if (duplicate !== undefined) {
        throw new Error(`OMP session "${session.id}" is already attached to harness session "${duplicate.agent.id}"`)
      }
      const currentSelection = agent.model.current()
      const selection = options.selection === undefined
        ? currentSelection
        : {
          ...options.selection,
          ...options.selection.reasoningEffort !== undefined || currentSelection?.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: currentSelection.reasoningEffort },
        }
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
        onUnsolicitedWake: ({ text, source }) => {
          agent.followup(createUserMessage({ content: [{ type: 'text', text }], source }))
        },
      })
      const disposeCommands = await this.registerCommands(agent, client)
      const socket = connection
      const live: LiveAttachment = {
        agent,
        client,
        ...launched === undefined ? {} : { launched },
        ...socket === undefined ? {} : { disconnect: () => { socket.close() } },
        ompSessionId: session.id,
        driver,
        hostTools,
        ui,
        pendingTools,
        disposeCommands,
        detachStream: () => {},
        cursor,
        todos: [],
      }
      live.detachStream = this.bindStream(live)
      await hostTools.sync()
      await this.publishTodos(live)
      this.attachments.set(agent.id, live)
      agent.ctx.effect(() => () => this.detach(agent.id), 'omp-rpc attachment')
      return {
        client,
        ...launched === undefined ? {} : { launched },
        catalog,
        session,
        cwd: options.cwd,
      }
    } catch (error: unknown) {
      connection?.close()
      await launched?.close()
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
   * Send one native RPC command to the process attached to a session.
   * @param id - harness session identity.
   * @param command - exact RPC command frame.
   * @returns the command response payload.
   */
  request(id: SessionId, command: OmpRpcCommand): Promise<unknown> {
    const live = this.attachments.get(id)
    if (live === undefined) throw new Error(`no OMP process is attached to session "${id}"`)
    return live.client.request(command)
  }

  /**
   * Run one slash command line in the process attached to a session.
   * @param id - harness session identity.
   * @param line - slash-prefixed command line OMP's prompt surface resolves.
   * @param signal - cancellation signal for the command run.
   * @returns the command output text.
   */
  runLine(id: SessionId, line: string, signal: AbortSignal): Promise<string> {
    const live = this.attachments.get(id)
    if (live === undefined) throw new Error(`no OMP process is attached to session "${id}"`)
    return runOmpCommand(live.client, line, signal)
  }

  /**
   * Stop the OMP process attached to one session.
   * @param id - harness session identity.
   */
  detach(id: SessionId): Promise<void> {
    return this.enqueueAttach(id, () => this.detachNow(id))
  }

  private async detachNow(id: SessionId): Promise<void> {
    const live = this.attachments.get(id)
    if (live === undefined) return
    this.attachments.delete(id)
    live.driver.close()
    live.detachStream()
    live.disposeCommands()
    live.hostTools.close()
    live.ui.close()
    live.disconnect?.()
    await live.launched?.close()
  }

  /** Stop every attachment, as when the owning plugin unloads. */
  async dispose(): Promise<void> {
    await Promise.all([...this.attachments.keys()].map(id => this.detach(id)))
  }

  private bindStream(live: LiveAttachment): () => void {
    const stopStep = live.agent.ctx.on('agent/step-stream', async (payload, next) => {
      if (payload.agent !== live.agent) return next()
      const nextTurn = payload.turn !== live.cursor.turn
      live.cursor.turn = payload.turn
      live.cursor.step = payload.step
      if (nextTurn && live.todos.length > 0) live.agent.session.append('todo/write', { todos: live.todos })
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
      for (const event of tools) this.projectTool(live, event)
    })
    const stopSessionEvents = live.agent.ctx.on('session/event', (session, event) => {
      if (session !== live.agent.session) return
      if (event.type === 'model/selection') {
        const level = event.data.reasoningEffort
        if (level === undefined || OMP_THINKING_LEVELS[level] !== true) return
        void live.client.request({ type: 'set_thinking_level', level }).catch(() => {})
        return
      }
      if (event.type !== 'agent/inbox/spliced') return
      if (event.data.target !== 'next-step' || event.data.inserted.length === 0) return
      if (!live.driver.hasActiveRun()) return
      void live.driver.steerImmediate(event.data.inserted).catch((error: unknown) => {
        this.options.ctx.logger.warn(`omp-rpc: live steer failed, retrying on the next step: ${String(error)}`)
      })
    })
    return () => {
      stopStep()
      stopAssistant()
      stopSessionEvents()
    }
  }

  private async readImages(refs: readonly OmpImageRef[]): Promise<OmpImageInput[]> {
    const attachments = this.options.ctx.get('attachments')
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
      source: { kind: 'omp-continue' },
    }))
  }

  private async registerCommands(agent: Agent, client: OmpRpcClient): Promise<() => void> {
    const definitions: Parameters<Context['commands']['register']>[0][] = [
      {
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
      },
    ]
    const disposers: (() => void)[] = []
    const seen = new Set<string>()
    try {
      for (const definition of agent.ctx.commands.list(agent)) seen.add(definition.name)
    } catch {
      // A scope without the commands service only offers the definitions registered here.
    }
    for (const definition of definitions) {
      if (seen.has(definition.name)) continue
      seen.add(definition.name)
      disposers.push(this.registerCommand(agent, definition))
    }
    const register = (command: OmpAvailableCommand): void => {
      if (seen.has(command.name) || CLIENT_OWNED_COMMANDS[command.name] === true) return
      seen.add(command.name)
      disposers.push(this.registerCommand(agent, {
        name: command.name,
        description: command.description ?? `Run OMP's native /${command.name} command in the attached session.`,
        ...command.input?.hint === undefined ? {} : { input: { hint: command.input.hint } },
        async handler(invocation) {
          try {
            return { kind: 'success', text: await runOmpCommand(client, ompNativeCommandLine(command.name, invocation.rawInput), invocation.signal) }
          } catch (error: unknown) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        },
      }))
    }
    const stopFrames = client.onFrame((frame) => {
      if (frame.type !== 'available_commands_update') return
      for (const command of ompAvailableCommands(objectOf(frame)?.commands)) register(command)
    })
    const response = await client.request({ type: 'get_available_commands' })
      .catch((error: unknown) => {
        this.options.ctx.logger.warn(`omp-rpc: native command discovery failed: ${String(error)}`)
        return undefined
      })
    for (const command of ompAvailableCommands(objectOf(response)?.commands)) register(command)
    return () => {
      stopFrames()
      for (const dispose of disposers) dispose()
    }
  }

  private registerCommand(
    agent: Agent,
    definition: Parameters<Context['commands']['register']>[0],
  ): () => void {
    return registerAgentCommand(agent, definition)
  }

  private projectTool(live: LiveAttachment, event: OmpToolEvent): void {
    const cursor = live.cursor
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
    if (event.toolName === 'todo' && !event.isError) void this.publishTodos(live)
  }

  private async publishTodos(live: LiveAttachment): Promise<void> {
    const state = await live.client.request({ type: 'get_state' }).catch(() => undefined)
    if (state === undefined) return
    live.todos = ompTodoItems(state)
    live.agent.session.append('todo/write', { todos: live.todos })
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
/**
 * Register one command on an agent scope whose commands service may inject later.
 * @param agent - exact receiving agent.
 * @param definition - command descriptor and handler.
 * @returns disposer that removes this exact registration.
 */
export function registerAgentCommand(
  agent: Agent,
  definition: Parameters<Context['commands']['register']>[0],
): () => void {
  const inject = typeof agent.ctx.inject === 'function' ? agent.ctx.inject.bind(agent.ctx) : undefined
  if (inject === undefined) return agent.ctx.commands.register(definition)
  const fiber = agent.ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register(definition))
  })
  return () => {
    void fiber.dispose()
  }
}

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
    const result = frame as OmpPromptResultFrame
    settled = true
    resolve({
      status: result.status,
      ...result.error?.message === undefined ? {} : { message: result.error.message },
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

