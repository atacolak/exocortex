/**
 * Metadata-only LLM adapter for sessions whose turns OMP executes natively.
 *
 * The harness model catalog, selection validation, and attachment checks read
 * this adapter; no model request is ever sent through it. `OmpSessionAgent`
 * forwards prompts over OMP RPC and consumes OMP's stream, so {@link stream}
 * refuses rather than silently speaking a second protocol.
 *
 * @module @deepseek-ai/dsh-omp-rpc/llm-catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'

/** Selectable OMP thinking levels, least to greatest. */
export const OMP_REASONING_EFFORTS = [
  { id: ReasoningEffortId('off'), name: 'Off' },
  { id: ReasoningEffortId('low'), name: 'Low' },
  { id: ReasoningEffortId('medium'), name: 'Medium' },
  { id: ReasoningEffortId('high'), name: 'High' },
  { id: ReasoningEffortId('xhigh'), name: 'Extra high' },
] as const

/** Default CPA route exposed to the harness model catalog. */
export const OMP_LLM_PROVIDER = 'cpa'

/** One model the staging CPA route serves through OMP. */
export interface OmpLlmModelSpec {
  readonly id: string
  readonly name: string
  readonly contextWindow: number
  readonly defaultEffort?: string
}

/**
 * Models the Exocortex CPA route advertises. OMP resolves the same ids
 * through its own gateway catalog; the list is metadata for DSH selectors.
 */
export const OMP_LLM_MODELS: readonly OmpLlmModelSpec[] = [
  { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon High', contextWindow: 1048576, defaultEffort: 'high' },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', contextWindow: 262144 },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', contextWindow: 262144 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 262144 },
  { id: 'kimi-k3-fast', name: 'Kimi K3 Fast', contextWindow: 262144 },
  { id: 'kimi-k3-slow', name: 'Kimi K3 Slow', contextWindow: 262144 },
  { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash High', contextWindow: 262144 },
  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 Thinking', contextWindow: 262144 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 262144 },
  { id: 'glm-5.3', name: 'GLM 5.3', contextWindow: 262144 },
]

function displayName(id: string): string {
  const words = id.split(/[-_.]/u).filter(word => word.length > 0)
  if (words.length === 0) return id
  return words.map(word => word[0]?.toUpperCase() === word[0] ? word : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`).join(' ')
}

function modelInfo(provider: string, spec: OmpLlmModelSpec): LlmResolvedModelInfo {
  return {
    provider,
    id: spec.id,
    name: spec.name,
    description: 'Executed natively by OMP',
    inputModalities: ['text', 'image'],
    context: { contextWindow: spec.contextWindow },
    reasoning: {
      efforts: [...OMP_REASONING_EFFORTS],
      ...spec.defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(spec.defaultEffort) },
    },
  }
}

/**
 * Adapter owning one metadata route; it never performs an HTTP model call.
 */
export class OmpLlmProvider extends LlmAdapter {
  private readonly models = new Map<string, OmpLlmModelSpec>()

  /**
   * @param provider - harness provider route this adapter owns.
   * @param specs - initial model metadata; defaults to the Exocortex CPA route.
   */
  constructor(
    readonly provider: string = OMP_LLM_PROVIDER,
    specs: readonly OmpLlmModelSpec[] = OMP_LLM_MODELS,
  ) {
    super()
    for (const spec of specs) this.models.set(spec.id, spec)
  }

  /** @returns harness-facing provider identity. */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'OMP (CPA Proxy)' }
  }

  /** @returns every advertised model in stable catalog order. */
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([...this.models.values()].map(spec => modelInfo(provider, spec)))
  }

  /**
   * Resolve one exact model, accepting a discovered id OMP reports after attach.
   * @param provider - this adapter's route.
   * @param model - exact model id.
   * @returns complete metadata for the route.
   */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const spec = this.models.get(model)
    return Promise.resolve(modelInfo(provider, spec ?? {
      id: model,
      name: displayName(model),
      contextWindow: 262144,
    }))
  }

  /**
   * Add ids discovered from a live OMP catalog without dropping known specs.
   * @param ids - provider-discovered model ids.
   */
  observe(ids: readonly string[]): void {
    for (const id of ids) {
      if (id.length === 0 || this.models.has(id)) continue
      this.models.set(id, { id, name: displayName(id), contextWindow: 262144 })
    }
  }

  /** Refuse direct dispatch: OMP owns every model request in this composition. */
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError(
      `model requests for "${this.provider}" are executed by OMP; mount @deepseek-ai/dsh-omp-rpc instead of calling the adapter`,
      'OMP_STREAM_UNSUPPORTED',
    )
  }
}

/**
 * Register the metadata route on a Cordis context.
 * @param ctx - context carrying the `llm` service.
 * @param provider - route to own; defaults to `cpa`.
 * @returns the adapter, registered for the context lifetime.
 */
export function registerOmpLlmProvider(ctx: Context, provider: string = OMP_LLM_PROVIDER): OmpLlmProvider {
  const adapter = new OmpLlmProvider(provider)
  ctx.effect(() => ctx.llm.registerAdapter([provider], adapter), 'omp-rpc llm metadata')
  return adapter
}
