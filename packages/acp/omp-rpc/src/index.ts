/**
 * Cordis composition of the OMP RPC bridge: auto-discovered `omp:<profile>`
 * agent presets, durable reattachment of OMP-preset sessions over a launched
 * process or a live session socket, pre-attach native command discovery,
 * automatic adoption of every live OMP session socket,
 * `POST /api/exocortex/omp/open`,
 * per-agent step streams, host tools, extension UI, catalog sync, and
 * trajectory projection.
 * @module @deepseek-ai/dsh-omp-rpc
 */

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-commands'
import { modelSelectionProjectionDefinition, type Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { SessionId } from '@deepseek-ai/dsh-session'
import { inboxProjectionDefinition, OmpAgentFactory, type OmpAgentHost } from './agent-factory.ts'
import { OMP_LLM_PROVIDER, registerOmpLlmProvider } from './llm-catalog.ts'
import type {} from '@deepseek-ai/dsh-workspace'
import Schema from '@deepseek-ai/schemastery'
import { bindingFactsOf, defaultOmpBindingsFile, hydrateOmpBinding, OmpBindings, rememberOmpBinding, type OmpBinding } from './bindings.ts'
import {
  OmpBridge,
  planOmpAttach,
  registerAgentCommand,
  resolveOmpExecutable,
  type OmpAttachOptions,
  type OmpAttachPlan,
  type OmpAttachment,
} from './bridge.ts'
import { DEFAULT_OMP_HOST_TOOLS } from './cordis-tools.ts'
import {
  listOmpSkills,
  ompNativeCommandCatalog,
  ompNativeCommandLine,
  resolveOmpSkills,
  type OmpSkillListing,
} from './native-commands.ts'
import {
  createOmpSessionLock,
  normalizeDshSessionId,
  OMP_OPEN_PATH,
  openOmpTranscript,
  planOmpWake,
  resumeRefused,
  reuseOrCreateDshSession,
  serveOmpOpen,
  type OmpWakePlan,
} from './open.ts'
import {
  discoverOmpPresets,
  ompPresetDefinition,
  ompPresetId,
  ompPresetOrder,
  ompProfileOfPreset,
} from './presets.ts'
import {
  OmpResumeError,
  probeOmpSessionLease,
  readOmpTranscriptHeader,
  resolveOmpTranscript,
  type OmpTranscriptMatch,
} from './resume.ts'
import {
  clearOmpSessionArtifacts,
  ompProcessAlive,
  probeOmpSocketSession,
  resolveOmpRunDirectory,
  watchOmpRunDirectory,
  type OmpSocketSession,
  type OmpSocketState,
} from './socket.ts'
import type { OmpUiAsker } from './ui.ts'
import type { OmpExtensionUiRequest } from './types.ts'

export * from './agent-factory.ts'
export * from './bindings.ts'
export * from './bridge.ts'
export * from './catalog.ts'
export * from './client.ts'
export * from './daemon.ts'
export * from './cordis-tools.ts'
export * from './driver.ts'
export * from './host-tools.ts'
export * from './launch.ts'
export * from './llm-catalog.ts'
export * from './native-commands.ts'
export * from './open.ts'
export * from './presets.ts'
export * from './resume.ts'
export * from './socket.ts'
export * from './ui.ts'
export * from './types.ts'

/** Directory OMP publishes its per-session transcripts and sockets under by default. */
export const DEFAULT_OMP_SESSIONS_ROOT = join(homedir(), '.omp', 'agent', 'sessions')

export const name = 'omp-rpc'
export const inject = ['agents', 'sessions', 'llm', 'sessionProjections', 'commands', 'subprocess', 'tools']

/** How one wake resolves, and whether dead publications were collected on the way. */
interface OmpWakeDecision {
  /** The attach, resume, or hung decision for the watched run directory. */
  readonly plan: OmpWakePlan
  /** True when at least one dead publication was cleared. */
  readonly collected: boolean
}

/** Plugin configuration for the OMP bridge. */
export interface OmpRpcConfig {
  /** OMP executable name or absolute path; defaults to `$OMP_BIN`, then `omp` on PATH. */
  readonly executable?: string
  /** Root directory holding every OMP transcript; defaults to the OMP sessions root. */
  readonly sessionDir?: string
  /** Root of the live OMP transcripts the open route resolves and resumes. */
  readonly ompSessionsRoot?: string
  /** Default `<agent>.md` profile passed as `--agent`. */
  readonly preset?: string
  /** Harness tools published to every OMP process. */
  hostTools?: string[]
  /** Working directory when a session header does not record one. */
  readonly cwd?: string
  /** Home directory owning `~/.omp/agent/agents`; defaults to the process home. */
  readonly home?: string
  /** Attach every OMP-preset session to OMP before its first step, resuming its durable transcript binding. */
  readonly autoAttach?: boolean
  /** hcom extension mounted into every launch; defaults to `~/.omp/agent/extensions/hcom.ts`, and an empty string disables it. */
  readonly hcomExtension?: string
  /** Durable session-to-transcript bindings file; defaults to `$DSH_HOME/omp/bindings.json`. */
  readonly bindingsFile?: string
  /**
   * Directory of live OMP session publications to adopt; defaults to
   * `$OMP_RUN_DIR`, then `<home>/.omp/run`. Pass `false` to disable adoption
   * (deterministic tests).
   */
  readonly watchRunDir?: string | false
  /** Adoption poll period in milliseconds; defaults to 1500. */
  readonly watchIntervalMs?: number
  /** Optional extension UI answerer supplied by a composed surface. */
  readonly asker?: OmpUiAsker
  /** Receives non-interactive OMP extension UI surfaces. */
  readonly onSurface?: (request: OmpExtensionUiRequest) => void
  /**
   * Start sessions this Bridge creates behind a detached keeper and reach OMP
   * over its published socket; defaults to true. Disable only where OMP is
   * modeled by an in-memory subprocess provider without a real socket daemon.
   */
  readonly detachedDaemon?: boolean
  /** Inactivity a detached keeper tolerates before ending OMP's request stream; defaults to one hour. */
  readonly daemonIdleTimeoutMs?: number
}

export const Config: Schema<OmpRpcConfig> = Schema.object({
  executable: Schema.string(),
  sessionDir: Schema.string(),
  ompSessionsRoot: Schema.string(),
  preset: Schema.string(),
  hostTools: Schema.array(Schema.string()),
  cwd: Schema.string(),
  home: Schema.string(),
  autoAttach: Schema.boolean(),
  hcomExtension: Schema.string(),
  bindingsFile: Schema.string(),
  watchRunDir: Schema.union([Schema.string(), Schema.const(false)]),
  watchIntervalMs: Schema.natural(),
  asker: Schema.any(),
  onSurface: Schema.any(),
  detachedDaemon: Schema.boolean(),
  daemonIdleTimeoutMs: Schema.natural(),
})

function attachmentSummary(attachment: OmpAttachment): string {
  const version = attachment.client.protocol
  const catalog = attachment.catalog.status === 'applied'
    ? `model ${attachment.catalog.model.id}`
    : attachment.catalog.status === 'not-offered'
      ? 'harness model not offered by the OMP gateway'
      : 'OMP default model'
  const transport = attachment.launched === undefined ? ' on its live session socket' : ''
  return `attached OMP RPC v${String(version)} (${catalog})${transport}`
}

async function existingFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined)
  return info?.isFile() === true
}

/** What one resolved transcript open produced. */
interface OmpTranscriptOpened {
  readonly transcript: OmpTranscriptMatch
  readonly summary: string
  readonly hydrated: number
}

/**
 * Mount the OMP bridge, its auto-discovered presets, its commands, and the
 * Exocortex open route that hydrates a real transcript into a session.
 * @param ctx - Cordis context carrying commands, tools, and subprocess.
 * @param config - executable, transcript root, profile, and host tool selection.
 */
export async function apply(ctx: Context, config: OmpRpcConfig): Promise<void> {
  const hcomExtension = config.hcomExtension ?? join(config.home ?? homedir(), '.omp', 'agent', 'extensions', 'hcom.ts')
  const bindings = new OmpBindings(config.bindingsFile ?? defaultOmpBindingsFile())
  const warn = (message: string, error?: unknown): void => {
    ctx.logger.warn(`[omp-rpc] ${message}${error === undefined ? '' : `: ${error instanceof Error ? error.message : String(error)}`}`)
  }
  const advanceOmpHydrationCursor = (
    sessionId: SessionId,
    cursor: { readonly entryId: string; readonly byteOffset: number },
  ): void => {
    void (async () => {
      try {
        const binding = await bindings.get(sessionId)
        if (binding === undefined) return
        await bindings.set(sessionId, {
          ...binding,
          hydratedLeafEntryId: cursor.entryId,
          hydratedByteOffset: cursor.byteOffset,
          updatedAt: new Date().toISOString(),
        })
      } catch (error: unknown) {
        warn(`cannot advance the hydration cursor for session "${sessionId}"`, error)
      }
    })()
  }
  const runDirectory = resolveOmpRunDirectory(
    config.watchRunDir === false ? undefined : config.watchRunDir,
    config.home,
  )
  const ompPublicationDir = join(config.home ?? homedir(), '.omp', 'run')
  const bridge = new OmpBridge({
    ctx,
    subprocess: ctx.subprocess,
    executable: resolveOmpExecutable(config.executable),
    ...hcomExtension.length === 0 ? {} : { hcomExtension },
    ...config.asker === undefined ? {} : { asker: config.asker },
    ...config.onSurface === undefined ? {} : { onSurface: config.onSurface },
    detachedDaemon: config.detachedDaemon ?? true,
    ...config.daemonIdleTimeoutMs === undefined ? {} : { daemonIdleTimeoutMs: config.daemonIdleTimeoutMs },
    runDirectory,
    publicationDir: ompPublicationDir,
    onCompactionCursor: advanceOmpHydrationCursor,
  })
  ctx.effect(() => () => bridge.dispose(), 'omp-rpc bridge')

  const sessionsRoot = config.ompSessionsRoot ?? DEFAULT_OMP_SESSIONS_ROOT
  const attachOptions = (agent: Agent, options: {
    readonly mode: OmpAttachOptions['mode']
    readonly preset?: string
    readonly sessionId?: string
    readonly socketPath?: string
    readonly resumePath?: string
    readonly forkPath?: string
    readonly cwd?: string
  }): OmpAttachOptions => {
    const cwd = options.cwd ?? agent.session.header.cwd ?? config.cwd
    if (cwd === undefined) throw new Error('OMP bridge has no working directory: set omp-rpc cwd or start the session in one')
    const preset = options.preset ?? config.preset
    const selection = agent.model.current()
    return {
      ...options,
      ...preset === undefined ? {} : { preset },
      ...selection === undefined ? {} : { selection },
      sessionDir: config.sessionDir ?? sessionsRoot,
      hostTools: config.hostTools ?? DEFAULT_OMP_HOST_TOOLS,
      managedStreams: true,
      cwd,
    }
  }

  const profileOf = (agent: Agent): string | undefined => {
    const preset = agent.ctx.get('agentPresets')?.composedPreset(agent.ctx)
    return preset === undefined ? undefined : ompProfileOfPreset(preset)
  }

  const serializeOpen = createOmpSessionLock()
  const watchDir = config.watchRunDir === false ? undefined : runDirectory

  const recordBranchFork = (sourceSessionId: SessionId, childSessionId: SessionId): void => {
    void (async () => {
      try {
        const source = await bindings.get(sourceSessionId)
        if (source === undefined || !(await existingFile(source.path))) return
        await bindings.setFork(childSessionId, {
          forkFromPath: source.path,
          cwd: source.cwd,
          updatedAt: new Date().toISOString(),
        })
      } catch (error: unknown) {
        warn(`cannot record OMP branch for session "${childSessionId}"`, error)
      }
    })()
  }
  ctx.on('session/forked', recordBranchFork)

  const forgetBinding = async (id: SessionId): Promise<void> => {
    try {
      await bindings.delete(id)
    } catch (error: unknown) {
      warn(`cannot drop binding for session "${id}"`, error)
    }
  }

  const bindingFacts = (attachment: OmpAttachment, profile?: string): OmpBinding | undefined =>
    bindingFactsOf({
      ompSessionId: attachment.session.id,
      path: attachment.session.path,
      cwd: attachment.cwd,
      ...profile === undefined ? {} : { profile },
    })

  const rememberBinding = async (agent: Agent, attachment: OmpAttachment, profile?: string): Promise<void> => {
    try {
      await rememberOmpBinding({ bindings, id: agent.id, facts: bindingFacts(attachment, profile) })
    } catch (error: unknown) {
      warn(`cannot persist binding for session "${agent.id}"`, error)
    }
  }

  const hydrateBoundTranscript = async (request: {
    readonly agent: Agent
    readonly binding: OmpBinding
    readonly cursor?: OmpBinding
    readonly includeNewestTurn: boolean
  }) => {
    const hydration = await hydrateOmpBinding({
      bindings,
      session: request.agent.session,
      binding: request.binding,
      ...request.cursor === undefined ? {} : { cursor: request.cursor },
      includeNewestTurn: request.includeNewestTurn,
    })
    bridge.seedDelivered(request.agent.id)
    return hydration
  }

  const readBinding = async (id: SessionId) => {
    try {
      return await bindings.get(id)
    } catch (error: unknown) {
      warn(`cannot read binding for session "${id}"`, error)
      return undefined
    }
  }

  const pinOpenedSession = async (agent: Agent, profile: string | undefined): Promise<void> => {
    if (profile !== 'argon') return
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return
    try {
      await registry.pinSession(agent.id)
    } catch (error: unknown) {
      warn(`cannot pin argon session "${agent.id}"`, error)
    }
  }

  const resolveTranscript = async (prefix: string): Promise<OmpTranscriptMatch> => {
    try {
      return await resolveOmpTranscript(sessionsRoot, prefix)
    } catch (error: unknown) {
      throw new OmpResumeError(
        'omp/transcript-not-found',
        error instanceof Error ? error.message : String(error),
        404,
      )
    }
  }

  /**
   * Decide how one harness session rejoins an OMP session publication.
   *
   * OMP unloads an idle process after 60 minutes without a terminal frame, and
   * a killed process skips its exit hook, so a run directory can hold artifacts
   * whose owner is gone. OMP always publishes under `$HOME/.omp/run` while this
   * host may watch a different `$OMP_RUN_DIR`, so the same session can leave a
   * dead publication in both places; each stale one is collected - sidecar,
   * socket, then bind lock - before the transcript resumes. A live publication
   * is never touched and only its socket is attachable.
   * @param ompSessionId - OMP session identity the binding recorded.
   * @returns the attach, resume, or hung decision and whether stale artifacts were collected,
   *   or undefined without an identity.
   */
  const wakeDecisionOf = async (ompSessionId: string | undefined): Promise<OmpWakeDecision | undefined> => {
    if (ompSessionId === undefined) return undefined
    const watched = await probeOmpSocketSession(runDirectory, ompSessionId)
    const publications: { readonly directory: string; readonly state: OmpSocketState }[] = [
      { directory: runDirectory, state: watched },
    ]
    if (ompPublicationDir !== runDirectory) {
      publications.push({ directory: ompPublicationDir, state: await probeOmpSocketSession(ompPublicationDir, ompSessionId) })
    }
    let collected = false
    for (const publication of publications) {
      if (publication.state.kind !== 'stale') continue
      warn(`collecting OMP session "${ompSessionId}" artifacts left by dead pid ${String(publication.state.pid)} in ${publication.directory}`)
      try {
        await clearOmpSessionArtifacts(publication.directory, ompSessionId)
        collected = true
      } catch (error: unknown) {
        warn(`cannot collect stale OMP session "${ompSessionId}" artifacts in ${publication.directory}`, error)
      }
    }
    return { plan: planOmpWake(watched), collected }
  }

  const openTranscriptNow = async (request: {
    readonly agent: Agent
    readonly transcript: OmpTranscriptMatch
    readonly cwd: string
    readonly profile?: string
  }): Promise<OmpTranscriptOpened> => {
    const { agent, transcript, cwd, profile } = request
    const served = bridge.attachedSession(agent.id)
    let attachment: OmpAttachment | undefined
    const opened = await openOmpTranscript({
      ompSessionId: transcript.id,
      attached: served,
      async attach() {
        const executable = await ctx.subprocess.resolveExecutable(resolveOmpExecutable(config.executable), undefined)
        const wake = await wakeDecisionOf(transcript.id)
        const lease = await probeOmpSessionLease(ctx.subprocess, executable, transcript.id, cwd)
        const busy = lease.held.includes(transcript.id) || lease.unknown.includes(transcript.id)
        const live = busy && wake?.plan.kind === 'attach' ? wake.plan.session : undefined
        if (busy && live === undefined && wake?.collected !== true) {
          const reason = wake?.plan.kind === 'hung'
            ? wake.plan.reason
            : lease.held.includes(transcript.id)
              ? 'is still open in a terminal pane that publishes no attach socket'
              : 'ownership could not be probed'
          throw new OmpResumeError(
            'omp/session-busy',
            `session ${transcript.id.slice(0, 8)} ${reason} — close/exit that pane first to release it`,
            409,
          )
        }
        try {
          attachment = await bridge.attach(agent, attachOptions(agent, {
            mode: 'attach',
            ...live === undefined
              ? { resumePath: transcript.path }
              : { socketPath: live.socketPath, sessionId: live.sessionId },
            cwd,
            ...profile === undefined ? {} : { preset: profile },
          }))
        } catch (error: unknown) {
          if (live !== undefined && ompProcessAlive(live.pid)) {
            throw new OmpResumeError(
              'omp/session-hung',
              `session ${transcript.id.slice(0, 8)} publishes a socket that no longer answers while process ${String(live.pid)} is still alive — close/exit that pane first to release it`,
              409,
            )
          }
          if (live === undefined) throw resumeRefused(error)
          throw error
        }
      },
      async hydrate() {
        const binding = await readBinding(agent.id)
        const hydration = await hydrateBoundTranscript({
          agent,
          binding: {
            ompSessionId: transcript.id,
            path: transcript.path,
            cwd,
            ...profile === undefined ? {} : { profile },
            updatedAt: new Date().toISOString(),
          },
          ...binding === undefined ? {} : { cursor: binding },
          includeNewestTurn: !(attachment?.session.streaming ?? served?.streaming ?? false),
        })
        return hydration.appended
      },
    })
    await pinOpenedSession(agent, profile)
    return {
      transcript,
      hydrated: opened.hydrated,
      summary: `resumed OMP session ${transcript.id.slice(0, 8)}${profile === undefined ? '' : ` as ${profile}`} (${opened.reused || attachment === undefined ? 'already attached' : attachmentSummary(attachment)})`,
    }
  }

  const opening = new Map<string, Promise<OmpTranscriptOpened>>()
  const openTranscript = (request: {
    readonly agent: Agent
    readonly transcript: OmpTranscriptMatch
    readonly cwd: string
    readonly profile?: string
  }): Promise<OmpTranscriptOpened> => {
    const key = String(request.agent.id)
    const pending = opening.get(key)
    if (pending !== undefined) return pending
    const started = openTranscriptNow(request).finally(() => {
      opening.delete(key)
      adopted.delete(key)
    })
    opening.set(key, started)
    return started
  }

  const attaching = new Map<string, Promise<void>>()
  const attachOmpSession = async (agent: Agent, profile?: string): Promise<void> => {
    if (bridge.attached(agent.id)) return
    let plan: OmpAttachPlan
    try {
      plan = await planOmpAttach({ sessionId: agent.id, bindings })
    } catch (error: unknown) {
      warn(`cannot read OMP bindings for session "${agent.id}"; starting a fresh OMP session`, error)
      plan = { mode: 'attach' }
    }
    let attachment: OmpAttachment | undefined
    const binding = plan.mode === 'attach' ? await readBinding(agent.id) : undefined
    const wake = (await wakeDecisionOf(binding?.ompSessionId))?.plan
    if (wake?.kind === 'attach') {
      const live = wake.session
      try {
        attachment = await bridge.attach(agent, attachOptions(agent, {
          mode: 'attach',
          socketPath: live.socketPath,
          sessionId: live.sessionId,
          ...profile === undefined ? {} : { preset: profile },
        }))
      } catch (error: unknown) {
        warn(`cannot attach live OMP socket for session "${live.sessionId}"; launching a fresh process`, error)
      }
    }
    try {
      attachment ??= await bridge.attach(agent, attachOptions(agent, {
        ...profile === undefined ? {} : { preset: profile },
        ...plan,
      }))
    } catch (error: unknown) {
      if (plan.resumePath === undefined) throw error
      warn(`cannot resume transcript ${plan.resumePath}; starting a fresh OMP session`, error)
      await forgetBinding(agent.id)
      attachment = await bridge.attach(agent, attachOptions(agent, {
        mode: 'attach',
        ...profile === undefined ? {} : { preset: profile },
      }))
    }
    if (binding?.path !== undefined && await existingFile(binding.path)) {
      try {
        await hydrateBoundTranscript({
          agent,
          binding,
          includeNewestTurn: !attachment.session.streaming,
        })
      } catch (error: unknown) {
        warn(`cannot tail-sync OMP transcript for session "${agent.id}"`, error)
      }
    }
    await rememberBinding(agent, attachment, profile)
    if (plan.forkPath !== undefined) {
      try {
        await bindings.deleteFork(agent.id)
      } catch (error: unknown) {
        warn(`cannot drop consumed branch fork for session "${agent.id}"`, error)
      }
    }
  }
  const ensureOmpSession = (agent: Agent, profile?: string): Promise<void> => {
    const pending = attaching.get(agent.id)
    if (pending !== undefined) return pending
    const started = attachOmpSession(agent, profile).finally(() => {
      attaching.delete(agent.id)
    })
    attaching.set(agent.id, started)
    return started
  }

  const skillListings = new Map<string, { readonly at: number; readonly skills: readonly OmpSkillListing[] }>()
  const skillRequests = new Map<string, Promise<readonly OmpSkillListing[]>>()
  const prepared = new Map<string, Promise<void>>()
  const SKILL_LISTING_TTL_MS = 60_000

  const skillsIn = (cwd: string): Promise<readonly OmpSkillListing[]> => {
    const cached = skillListings.get(cwd)
    if (cached !== undefined && cached.skills.length > 0 && Date.now() - cached.at < SKILL_LISTING_TTL_MS) {
      return Promise.resolve(cached.skills)
    }
    const pending = skillRequests.get(cwd)
    if (pending !== undefined) return pending
    const request = resolveOmpSkills({
      cwd,
      home: config.home ?? homedir(),
      list: async () => {
        const executable = await ctx.subprocess.resolveExecutable(resolveOmpExecutable(config.executable), undefined)
        return await listOmpSkills(ctx.subprocess, executable, cwd)
      },
    }).then((skills) => {
      if (skills.length > 0) skillListings.set(cwd, { at: Date.now(), skills })
      else skillListings.delete(cwd)
      return skills
    }).finally(() => {
      skillRequests.delete(cwd)
    })
    skillRequests.set(cwd, request)
    return request
  }

  const prepareNativeCommands = (agent: Agent): void => {
    const key = String(agent.id)
    if (prepared.has(key)) return
    const commands = agent.ctx.get('commands')
    if (commands === undefined) return
    const cwd = agent.session.header.cwd ?? config.cwd ?? process.cwd()
    const started = skillsIn(cwd).then((skills) => {
      const known = new Set<string>()
      for (const definition of commands.list(agent)) known.add(definition.name)
      const disposers: (() => void)[] = []
      for (const command of ompNativeCommandCatalog(skills)) {
        if (known.has(command.name)) continue
        known.add(command.name)
        const dispose = registerAgentCommand(agent, {
          name: command.name,
          description: command.description ?? `Run OMP's native /${command.name} command in this session.`,
          ...command.hint === undefined ? {} : { input: { hint: command.hint } },
          async handler(invocation) {
            const profile = profileOf(invocation.agent) ?? config.preset
            try {
              await ensureOmpSession(invocation.agent, profile)
              return {
                kind: 'success',
                text: await bridge.runLine(invocation.agent.id, ompNativeCommandLine(command.name, invocation.rawInput), invocation.signal),
              }
            } catch (error: unknown) {
              return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
            }
          },
        }, (error: unknown) => {
          warn(`cannot register OMP command "${command.name}" for session "${key}"`, error)
        })
        if (dispose !== undefined) disposers.push(dispose)
      }
      agent.ctx.effect(() => () => {
        for (const dispose of disposers.splice(0)) dispose()
      }, 'omp-rpc native commands')
      if (skills.length === 0) prepared.delete(key)
    }).catch((error: unknown) => {
      prepared.delete(key)
      warn(`cannot pre-populate native OMP commands for session "${key}"`, error)
    })
    prepared.set(key, started)
  }

  const agentHost: OmpAgentHost = {
    ensureSession: agent => ensureOmpSession(agent, profileOf(agent) ?? config.preset),
    driverOf: id => bridge.driverOf(id),
    takeTools: id => bridge.takeTools(id),
    projectTools: (id, turn, step, events) => { bridge.projectTools(id, turn, step, events) },
    modelSelection: session => modelSelection.readerFor(session),
    inbox: session => inbox.readerFor(session),
  }

  const hydrateBoundSession = async (agent: Agent): Promise<void> => {
    const binding = await readBinding(agent.id)
    if (binding === undefined || !(await existingFile(binding.path))) return
    try {
      const wake = (await wakeDecisionOf(binding.ompSessionId))?.plan
      await hydrateBoundTranscript({
        agent,
        binding,
        includeNewestTurn: wake?.kind !== 'attach',
      })
    } catch (error: unknown) {
      warn(`cannot tail-sync OMP transcript for reopened session "${agent.id}"`, error)
    }
  }

  const modelSelection = await ctx.sessionProjections.register(modelSelectionProjectionDefinition)
  const inbox = await ctx.sessionProjections.register(inboxProjectionDefinition)
  registerOmpLlmProvider(ctx, OMP_LLM_PROVIDER)
  ctx.effect(() => ctx.agents.setFactory(new OmpAgentFactory({
    ctx,
    host: agentHost,
    hydrate: hydrateBoundSession,
  })), 'omp-rpc agent factory')

  const hosted = new Map<string, SessionId>()
  const adopting = new Set<string>()
  const adopted = new Set<string>()
  let presetNames: ReadonlySet<string> | undefined

  ctx.on('agent/created', (payload) => {
    if (adopted.has(String(payload.agent.id))) return
    prepareNativeCommands(payload.agent)
    void ensureOmpSession(payload.agent, profileOf(payload.agent) ?? config.preset).catch((error: unknown) => {
      warn(`cannot attach native OMP session "${payload.agent.id}"`, error)
    })
  })

  const attachWorkspace = async (sessionId: SessionId, cwd: string, create: boolean): Promise<void> => {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return
    try {
      const workspace = await registry.resolveByPath(cwd)
        ?? (create ? await registry.create(cwd) : undefined)
      if (workspace === undefined || workspace.sessionIds.includes(sessionId)) return
      await workspace.attachSession(sessionId)
    } catch (error: unknown) {
      warn(`cannot attach adopted session "${sessionId}" to workspace "${cwd}"`, error)
    }
  }

  const adoptLiveSession = async (controller: SessionController, live: OmpSocketSession): Promise<void> => {
    if (bridge.servesOmpSession(live.sessionId)) return
    const bound = await bindings.findByOmpSessionId(live.sessionId)
    let sessionId = bound?.sessionId ?? hosted.get(live.sessionId)
    let profile = bound?.binding.profile
    const transcriptPath = live.sessionFile ?? bound?.binding.path
    let created = false
    if (sessionId === undefined) {
      if (live.sessionFile === undefined || presetNames === undefined) return
      const header = await readOmpTranscriptHeader(live.sessionFile).catch(() => undefined)
      if (header === undefined) return
      const discovered = header.profile !== undefined && presetNames.has(header.profile) ? header.profile : undefined
      const generated = SessionId(normalizeDshSessionId(randomUUID()))
      hosted.set(live.sessionId, generated)
      adopted.add(String(generated))
      const result = await controller.create({
        sessionId: generated,
        cwd: live.cwd,
        ...discovered === undefined ? {} : { agentPreset: ompPresetId(discovered) },
      })
      sessionId = result.sessionId
      hosted.set(live.sessionId, sessionId)
      profile = discovered
      created = true
    }
    const resolved = await controller.resolveAgent(sessionId)
    adopted.delete(String(sessionId))
    if ('error' in resolved) {
      hosted.delete(live.sessionId)
      return
    }
    const agent = resolved.agent
    if (bridge.attached(agent.id)) {
      await attachWorkspace(agent.id, live.cwd, false)
      return
    }
    const attachment = await bridge.attach(agent, attachOptions(agent, {
      mode: 'attach',
      socketPath: live.socketPath,
      sessionId: live.sessionId,
      cwd: live.cwd,
      ...profile === undefined ? {} : { preset: profile },
    }))
    const facts = bindingFacts(attachment, profile)
    const source = facts ?? bound?.binding
    if (transcriptPath !== undefined && source !== undefined) {
      try {
        await hydrateBoundTranscript({
          agent,
          binding: source,
          ...bound === undefined ? {} : { cursor: bound.binding },
          includeNewestTurn: !attachment.session.streaming,
        })
      } catch (error: unknown) {
        warn(`cannot hydrate adopted session "${agent.id}"`, error)
      }
    }
    await rememberBinding(agent, attachment, profile)
    await attachWorkspace(agent.id, live.cwd, created)
  }

  const onLiveSession = (controller: SessionController, live: OmpSocketSession): void => {
    if (adopting.has(live.sessionId)) return
    adopting.add(live.sessionId)
    void serializeOpen(live.sessionId, async () => { await adoptLiveSession(controller, live) })
      .catch((error: unknown) => {
        warn(`cannot adopt live OMP session "${live.sessionId}"`, error)
      })
      .finally(() => {
        adopting.delete(live.sessionId)
      })
  }

  if (watchDir !== undefined) {
    ctx.inject(['sessionController'], (sessionCtx) => {
      const controller = sessionCtx.get('sessionController')
      if (controller === undefined) return
      sessionCtx.effect(() => watchOmpRunDirectory({
        runDir: watchDir,
        ...config.watchIntervalMs === undefined ? {} : { intervalMs: config.watchIntervalMs },
        onSession: (live) => { onLiveSession(controller, live) },
      }), 'omp-rpc live session adoption')
    })
  }

  ctx.inject(['commands'], (commandCtx) => {
    try {
      commandCtx.effect(() => commandCtx.commands.register({
        name: 'compact',
        description: 'Compact the attached OMP session natively, preserving its own summary and transcript.',
        input: { hint: '[instructions]' },
        async handler(invocation) {
          const profile = profileOf(invocation.agent)
          if (profile === undefined) {
            return { kind: 'error', text: '/compact applies only to OMP agent presets.' }
          }
          await ensureOmpSession(invocation.agent, profile)
          try {
            const { tokensBefore } = await bridge.compact(invocation.agent.id, invocation.rawInput, invocation.commandId)
            const before = tokensBefore === undefined ? '' : ` (${String(tokensBefore)} tokens before)`
            return { kind: 'success', text: `Compacted OMP context${before}.` }
          } catch (error: unknown) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        },
      }), 'omp-rpc native /compact')
    } catch (error: unknown) {
      warn('native /compact is already registered globally; per-session registration remains available', error)
    }
  })

  ctx.inject(['agentPresets'], (presetCtx) => {
    if (config.autoAttach !== false) {
      ctx.on('agent/created', (payload) => {
        if (adopted.has(String(payload.agent.id))) return
        const profile = profileOf(payload.agent)
        if (profile === undefined) return
        void ensureOmpSession(payload.agent, profile).catch((error: unknown) => {
          warn(`eager OMP attach for session "${payload.agent.id}" failed`, error)
        })
      })
      ctx.on('agent/pre-step', async (payload, next) => {
        if (adopted.has(String(payload.agent.id))) return next()
        if (bridge.attached(payload.agent.id)) return next()
        const profile = profileOf(payload.agent)
        if (profile === undefined) return next()
        await ensureOmpSession(payload.agent, profile)
        return next()
      })
    }
    return discoverOmpPresets({
      cwd: config.cwd ?? process.cwd(),
      ...config.home === undefined ? {} : { home: config.home },
    }).then(async (presets) => {
      const ordered = presets.sort((left, right) => left.name.localeCompare(right.name))
      presetNames = new Set(ordered.map(preset => preset.name))
      for (const preset of ordered) {
        await presetCtx.agentPresets.register(ompPresetDefinition(preset, ompPresetOrder(preset.name)))
      }
    })
  })

  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => connectionCtx.connection.fetch.register({
      path: OMP_OPEN_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => serveOmpOpen(request, {
        resolveTranscript,
        serialize: serializeOpen,
        ...config.cwd === undefined ? {} : { defaultCwd: config.cwd },
        ...config.preset === undefined ? {} : { defaultProfile: config.preset },
        async openAgent(input) {
          const controller = connectionCtx.get('sessionController')
          if (controller === undefined) {
            throw new OmpResumeError(
              'omp/session-controller-unavailable',
              'The session controller is not mounted; pass an existing live sessionId instead.',
              503,
            )
          }
          if (input.sessionId !== undefined) {
            const resolved = await controller.resolveAgent(SessionId(input.sessionId))
            if ('error' in resolved) {
              throw new OmpResumeError(
                resolved.error.code,
                resolved.error.message,
                resolved.error.code === 'session/not-found' ? 404 : 409,
              )
            }
            return { agent: resolved.agent }
          }
          try {
            let createdPreset: string | undefined
            const target = await reuseOrCreateDshSession({
              ompSessionId: input.ompSessionId,
              findBound: async () => (await bindings.findByOmpSessionId(input.ompSessionId))?.sessionId,
              create: async () => {
                const generated = SessionId(normalizeDshSessionId(randomUUID()))
                adopted.add(String(generated))
                try {
                  const created = await controller.create({
                    sessionId: generated,
                    cwd: input.cwd,
                    ...input.profile === undefined ? {} : { agentPreset: ompPresetId(input.profile) },
                  })
                  createdPreset = created.agentPreset
                  return created.sessionId
                } catch (error: unknown) {
                  adopted.delete(String(generated))
                  throw error
                }
              },
            })
            const resolved = await controller.resolveAgent(target.sessionId)
            if ('error' in resolved) {
              throw new OmpResumeError(resolved.error.code, resolved.error.message, 409)
            }
            return {
              agent: resolved.agent,
              ...createdPreset === undefined ? {} : { agentPreset: createdPreset },
            }
          } catch (error: unknown) {
            if (error instanceof OmpResumeError) throw error
            throw new OmpResumeError(
              'session/create-failed',
              error instanceof Error ? error.message : String(error),
              409,
            )
          }
        },
        async openTranscript(input) {
          const opened = await openTranscript({
            agent: input.agent,
            transcript: input.transcript,
            cwd: input.cwd,
            ...input.profile === undefined ? {} : { profile: input.profile },
          })
          return { summary: opened.summary, hydrated: opened.hydrated }
        },
        logError(error) {
          connectionCtx.logger.error(`[exocortex/omp/open] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
        },
      }),
    }), 'omp-rpc /api/exocortex/omp/open')
  })
}
