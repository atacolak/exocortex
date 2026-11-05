/**
 * Metadata-only LLM adapters for sessions whose turns OMP executes natively.
 *
 * The harness model catalog, selection validation, and attachment checks read
 * these routes; no model request is ever sent through them. Every route and
 * model comes from OMP's authenticated catalog, so `/switch` and the model
 * picker offer exactly what OMP itself can dispatch. `OmpSessionAgent` forwards
 * prompts over OMP RPC and consumes OMP's stream, so {@link OmpLlmProvider.stream}
 * refuses rather than silently speaking a second protocol.
 *
 * @module @deepseek-ai/dsh-omp-rpc/llm-catalog
 */
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  LlmError,
  type AdapterRegistrationHandle,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import {
  loadOmpModelCatalog,
  type OmpCatalogModel,
  type OmpModelCatalogSnapshot,
} from './model-catalog.ts'

/** Selectable OMP thinking levels, least to greatest. */
export const OMP_REASONING_EFFORTS = [
  { id: ReasoningEffortId('off'), name: 'Off' },
  { id: ReasoningEffortId('minimal'), name: 'Minimal' },
  { id: ReasoningEffortId('low'), name: 'Low' },
  { id: ReasoningEffortId('medium'), name: 'Medium' },
  { id: ReasoningEffortId('high'), name: 'High' },
  { id: ReasoningEffortId('xhigh'), name: 'Extra high' },
  { id: ReasoningEffortId('max'), name: 'Max' },
] as const

const OFF_EFFORT = OMP_REASONING_EFFORTS[0]

/** Route kept for the profile default model while the live catalog loads or fails. */
export const OMP_LLM_PROVIDER = 'cpa'

/** How long a resolution keeps the catalog it already read before refreshing. */
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  cpa: 'OMP (CPA Proxy)',
  cerebras: 'Cerebras',
  'cline-pass': 'Cline Pass',
  cursor: 'Cursor',
  experientiallabs: 'Experiential Labs',
  'google-antigravity': 'Google Antigravity',
  'google-gemini-cli': 'Google Gemini CLI',
  grokbot: 'GrokBot',
  meridian: 'Meridian',
  'openai-codex': 'OpenAI Codex',
  'opencode-go': 'OpenCode Go',
  trytokenfactory: 'Token Factory',
  'trytokenfactory-thinking': 'Token Factory Thinking',
  'xai-oauth': 'xAI',
}

/** One catalog refresh source and its diagnostics. */
export interface OmpLlmProviderOptions {
  /** Reads OMP's authenticated catalog; every call may return a fresh snapshot. */
  readonly load: () => Promise<OmpModelCatalogSnapshot>
  /** Resolution lifetime of one snapshot; `0` disables periodic refresh. */
  readonly refreshIntervalMs?: number
  /** Receives a failed refresh without aborting the previous catalog. */
  readonly warn?: (message: string, error: unknown) => void
}

/** Registration options: either an explicit loader or the local OMP home. */
export interface OmpLlmRegistrationOptions extends Omit<OmpLlmProviderOptions, 'load'> {
  /** Reuse a loader built by the caller, such as one resolving an OMP executable. */
  readonly load?: () => Promise<OmpModelCatalogSnapshot>
  /** OMP executable name or absolute path; defaults to `omp` on PATH. */
  readonly executable?: string
  /** OMP home holding `agent/models.yml` and `agent/config.yml`; defaults to `$HOME`. */
  readonly home?: string
  /** Directory OMP resolves config and discovery from; defaults to the process cwd. */
  readonly cwd?: string
}

function displayName(id: string): string {
  const words = id.split(/[-_.]/u).filter(word => word.length > 0)
  if (words.length === 0) return id
  return words
    .map(word => word[0] === undefined ? word : `${word[0].toUpperCase()}${word.slice(1)}`)
    .join(' ')
}

function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? displayName(provider)
}

function badgeOf(model: OmpCatalogModel): LlmModelInfo['badge'] | undefined {
  if (model.roles.length === 0) return undefined
  return { text: model.roles.map(role => `@${role}`).join(' '), tone: 'neutral' }
}

function modelInfo(provider: string, model: OmpCatalogModel, listed: boolean): LlmModelInfo {
  const badge = listed ? badgeOf(model) : undefined
  return {
    provider,
    id: model.id,
    name: model.name,
    description: 'Executed natively by OMP',
    ...model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] },
    ...badge === undefined ? {} : { badge },
  }
}

function resolvedInfo(provider: string, model: OmpCatalogModel): LlmResolvedModelInfo {
  const efforts = model.thinkingLevels.map(level =>
    OMP_REASONING_EFFORTS.find(effort => String(effort.id) === level) ?? OFF_EFFORT)
  const defaultEffort = model.defaultThinkingLevel
  return {
    ...modelInfo(provider, model, false),
    ...model.contextWindow === undefined ? {} : { context: { contextWindow: model.contextWindow } },
    ...model.maxTokens === undefined ? {} : { defaultMaxTokens: model.maxTokens },
    ...efforts.length === 0 ? {} : {
      reasoning: {
        efforts: [OFF_EFFORT, ...efforts],
        ...defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultEffort) },
      },
    },
  }
}

function discoveredInfo(provider: string, model: string): LlmResolvedModelInfo {
  return { provider, id: model, name: displayName(model) }
}

/**
 * Adapter owning every authenticated OMP route; it never performs an HTTP model call.
 */
export class OmpLlmProvider extends LlmAdapter {
  private readonly options: OmpLlmProviderOptions
  private routes = new Map<string, ReadonlyMap<string, OmpCatalogModel>>()
  private readonly owned = new Set<string>()
  private registration: AdapterRegistrationHandle | undefined
  private loading: Promise<void> | undefined
  private loadedAt = 0
  private closed = false
  private timer: NodeJS.Timeout | undefined
  private ctx: Context | undefined
  private readonly firstLoad = Promise.withResolvers<undefined>()

  /**
   * @param options - catalog source, refresh interval, and diagnostics.
   */
  constructor(options: OmpLlmProviderOptions) {
    super()
    this.options = options
  }

  /** Resolve once the first catalog read settled, successfully or not. */
  get ready(): Promise<undefined> {
    return this.firstLoad.promise
  }

  /**
   * Read OMP's catalog again and replace the registered routes atomically.
   * @returns after the refreshed snapshot was applied or the failure was reported.
   */
  refresh(): Promise<void> {
    return this.load()
  }

  /** @returns harness-facing provider identity. */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: providerName(provider) }
  }

  /** @returns every advertised model for one route in catalog order. */
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.refreshIfStale()
    return Promise.resolve([...(this.routes.get(provider)?.values() ?? [])]
      .map(model => modelInfo(provider, model, true)))
  }

  /**
   * Resolve one exact model, accepting an id OMP reports after this snapshot.
   * @param provider - one registered OMP route.
   * @param model - exact model id.
   * @returns complete metadata for the route.
   */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.refreshIfStale()
    const found = this.routes.get(provider)?.get(model)
    return Promise.resolve(found === undefined ? discoveredInfo(provider, model) : resolvedInfo(provider, found))
  }

  /** Refuse direct dispatch: OMP owns every model request in this composition. */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError(
      `model requests for "${options.provider}" are executed by OMP; mount @deepseek-ai/dsh-omp-rpc instead of calling the adapter`,
      'OMP_STREAM_UNSUPPORTED',
    )
  }

  /**
   * Bind the adapter to the context whose `llm` registry it populates.
   * @param ctx - context carrying the `llm` service.
   */
  attach(ctx: Context): void {
    this.ctx = ctx
    this.seedRoute()
    void this.start()
  }

  /** Stop refreshing; the owning context disposes the registered routes. */
  detach(): void {
    this.closed = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private seedRoute(): void {
    if (this.ctx === undefined) return
    this.routes.set(OMP_LLM_PROVIDER, new Map())
    try {
      this.registration = this.ctx.llm.registerAdapter([OMP_LLM_PROVIDER], this)
      this.owned.add(OMP_LLM_PROVIDER)
    } catch (error: unknown) {
      this.warn(`cannot reserve the "${OMP_LLM_PROVIDER}" route`, error)
    }
  }

  private async start(): Promise<void> {
    try {
      await this.load()
    } finally {
      this.firstLoad.resolve(undefined)
    }
    const interval = this.options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
    if (this.closed || interval <= 0) return
    this.timer = setInterval(() => { void this.load() }, interval)
    this.timer.unref()
  }

  private load(): Promise<void> {
    if (this.closed) return Promise.resolve()
    const pending = this.options.load()
      .then((snapshot) => { this.apply(snapshot) })
      .catch((error: unknown) => { this.warn('cannot read the OMP model catalog', error) })
      .finally(() => { if (this.loading === pending) this.loading = undefined })
    this.loading = pending
    return pending
  }

  private refreshIfStale(): void {
    const interval = this.options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
    if (this.closed || interval <= 0 || this.loading !== undefined) return
    if (Date.now() - this.loadedAt < interval) return
    void this.load()
  }

  private apply(snapshot: OmpModelCatalogSnapshot): void {
    const ctx = this.ctx
    if (this.closed || ctx === undefined) return
    const grouped = new Map<string, Map<string, OmpCatalogModel>>()
    for (const model of snapshot.models) {
      const models = grouped.get(model.provider) ?? new Map<string, OmpCatalogModel>()
      models.set(model.id, model)
      grouped.set(model.provider, models)
    }
    if (!grouped.has(OMP_LLM_PROVIDER)) grouped.set(OMP_LLM_PROVIDER, new Map())
    const registered = new Set(ctx.llm.listProviders().map(info => info.id))
    const providers = [...grouped.keys()]
      .filter(provider => this.owned.has(provider) || !registered.has(provider))
    if (providers.length === 0) return
    try {
      if (this.registration === undefined) {
        this.registration = ctx.llm.registerAdapter(providers, this)
      } else {
        this.registration.replace(providers)
      }
    } catch (error: unknown) {
      this.warn('cannot publish the OMP model catalog', error)
      return
    }
    this.owned.clear()
    for (const provider of providers) this.owned.add(provider)
    this.routes = grouped
    this.loadedAt = Date.now()
    for (const provider of providers) ctx.emit('llm/models-updated', provider)
  }

  private warn(message: string, error: unknown): void {
    const warn = this.options.warn
    if (warn === undefined) return
    warn(message, error)
  }
}

/**
 * Register every authenticated OMP route on a Cordis context.
 * @param ctx - context carrying the `llm` service.
 * @param options - catalog loader or the local OMP executable and home.
 * @returns the adapter; await {@link OmpLlmProvider.ready} for the first snapshot.
 */
export function registerOmpLlmProvider(
  ctx: Context,
  options: OmpLlmRegistrationOptions = {},
): OmpLlmProvider {
  const load = options.load ?? (() => loadOmpModelCatalog({
    executable: options.executable ?? 'omp',
    home: options.home ?? homedir(),
    cwd: options.cwd ?? process.cwd(),
  }))
  const adapter = new OmpLlmProvider({
    load,
    ...options.refreshIntervalMs === undefined ? {} : { refreshIntervalMs: options.refreshIntervalMs },
    warn: options.warn ?? ((message, error) => {
      ctx.logger.warn(`[omp-rpc] ${message}`)
      ctx.logger.warn(error)
    }),
  })
  ctx.effect(() => {
    adapter.attach(ctx)
    return () => { adapter.detach() }
  }, 'omp-rpc llm catalog')
  return adapter
}
