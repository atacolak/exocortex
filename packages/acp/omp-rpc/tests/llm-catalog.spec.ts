import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import {
  OMP_REASONING_EFFORTS,
  OmpLlmProvider,
  registerOmpLlmProvider,
} from '../src/llm-catalog.ts'
import type { OmpCatalogModel, OmpModelCatalogSnapshot } from '../src/model-catalog.ts'

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  return ctx
}

function model(
  provider: string,
  id: string,
  overrides: Partial<OmpCatalogModel> = {},
): OmpCatalogModel {
  return {
    provider,
    id,
    name: id,
    thinkingLevels: [],
    roles: [],
    ...overrides,
  }
}

function snapshot(...models: OmpCatalogModel[]): OmpModelCatalogSnapshot {
  return { models }
}

const CATALOG = snapshot(
  model('cpa', 'gemini-4-argon-high', {
    name: 'Gemini 4 Argon',
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    inputModalities: ['text', 'image'],
    thinkingLevels: ['low', 'medium', 'high'],
    defaultThinkingLevel: 'high',
    roles: ['smol'],
  }),
  model('cpa', 'gpt-6.1-sol', { name: 'GPT-6.1 Sol', contextWindow: 262_144 }),
  model('opencode-go', 'deepseek-v4.1-flash', {
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    inputModalities: ['text', 'image'],
    thinkingLevels: ['low', 'high', 'max'],
    defaultThinkingLevel: 'high',
    roles: ['default', 'builder'],
  }),
  model('openai-codex', 'gpt-6.1-sol', {
    name: 'GPT-6.1 Sol',
    contextWindow: 400_000,
    thinkingLevels: ['minimal', 'low', 'medium', 'high'],
    defaultThinkingLevel: 'medium',
    roles: ['plan'],
  }),
  model('google-antigravity', 'gemini-4-argon-high', {
    name: 'Gemini 4 Argon High',
    inputModalities: ['text', 'image'],
  }),
)

describe('OMP metadata routes', () => {
  it('registers every authenticated provider OMP reports', async () => {
    const ctx = await harness()
    const adapter = registerOmpLlmProvider(ctx, { load: () => Promise.resolve(CATALOG) })
    await adapter.ready
    expect(ctx.llm.listProviders()).toEqual([
      { id: 'cpa', name: 'OMP (CPA Proxy)' },
      { id: 'opencode-go', name: 'OpenCode Go' },
      { id: 'openai-codex', name: 'OpenAI Codex' },
      { id: 'google-antigravity', name: 'Google Antigravity' },
    ])
  })

  it('lists the live models for a provider with their OMP metadata and role badges', async () => {
    const ctx = await harness()
    const adapter = registerOmpLlmProvider(ctx, { load: () => Promise.resolve(CATALOG) })
    await adapter.ready
    expect(await ctx.llm.listModels('opencode-go')).toEqual([{
      provider: 'opencode-go',
      id: 'deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      description: 'Executed natively by OMP',
      inputModalities: ['text', 'image'],
      badge: { text: '@default @builder', tone: 'neutral' },
    }])
    expect(await ctx.llm.listModels('cpa')).toHaveLength(2)
  })

  it('resolves per-model context, output cap, and only the efforts that model supports', async () => {
    const ctx = await harness()
    const adapter = registerOmpLlmProvider(ctx, { load: () => Promise.resolve(CATALOG) })
    await adapter.ready
    const resolved = await ctx.llm.resolveModelInfo('openai-codex', 'gpt-6.1-sol')
    expect(resolved).toMatchObject({
      provider: 'openai-codex',
      id: 'gpt-6.1-sol',
      context: { contextWindow: 400_000 },
      reasoning: { defaultEffort: 'medium' },
    })
    expect(resolved.reasoning?.efforts.map(effort => effort.id))
      .toEqual(['off', 'minimal', 'low', 'medium', 'high'])
    expect(resolved.badge).toBeUndefined()
  })

  it('advertises no reasoning ladder or invented context for models without them', async () => {
    const adapter = new OmpLlmProvider({ load: () => Promise.resolve(CATALOG) })
    const ctx = await harness()
    adapter.attach(ctx)
    await adapter.ready
    const resolved = await adapter.resolveModel('google-antigravity', 'gemini-4-argon-high')
    expect(resolved.context).toBeUndefined()
    expect(resolved.reasoning).toBeUndefined()
  })

  it('keeps the default CPA route while the first catalog read is pending', async () => {
    const ctx = await harness()
    const deferred = Promise.withResolvers<OmpModelCatalogSnapshot>()
    const adapter = registerOmpLlmProvider(ctx, { load: () => deferred.promise })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['cpa'])
    expect(await ctx.llm.listModels('cpa')).toEqual([])
    deferred.resolve(CATALOG)
    await adapter.ready
    expect(ctx.llm.listProviders().map(provider => provider.id))
      .toEqual(['cpa', 'opencode-go', 'openai-codex', 'google-antigravity'])
  })

  it('replaces routes and announces model updates when OMP authenticates another provider', async () => {
    const ctx = await harness()
    let current = snapshot(model('cpa', 'gemini-4-argon-high'))
    const updated: string[] = []
    ctx.on('llm/models-updated', provider => { updated.push(provider) })
    const adapter = registerOmpLlmProvider(ctx, { load: () => Promise.resolve(current) })
    await adapter.ready
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['cpa'])
    current = snapshot(
      model('cpa', 'gemini-4-argon-high'),
      model('opencode-go', 'deepseek-v4.1-flash', { name: 'DeepSeek V4.1 Flash' }),
    )
    await adapter.refresh()
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['cpa', 'opencode-go'])
    expect(updated).toContain('opencode-go')
  })

  it('accepts an id OMP has not advertised yet without inventing metadata', async () => {
    const adapter = new OmpLlmProvider({ load: () => Promise.resolve(CATALOG) })
    adapter.attach(await harness())
    await adapter.ready
    expect(await adapter.resolveModel('cpa', 'x-custom-route')).toEqual({
      provider: 'cpa',
      id: 'x-custom-route',
      name: 'X Custom Route',
    })
  })

  it('refuses a direct dispatch instead of speaking a second protocol', async () => {
    const adapter = new OmpLlmProvider({ load: () => Promise.resolve(CATALOG) })
    const request: GenerateOptions = { provider: 'cpa', model: 'gemini-4-argon-high', messages: [] }
    await expect(async () => {
      for await (const _chunk of adapter.stream(request)) { /* unreachable */ }
    }).rejects.toBeInstanceOf(LlmError)
  })

  it('releases every route when the registering context is disposed', async () => {
    const ctx = await harness()
    let adapter: OmpLlmProvider | undefined
    const fiber = await ctx.plugin({
      name: 'omp-rpc llm catalog disposable',
      inject: ['llm'],
      apply(pluginCtx: Context) {
        adapter = registerOmpLlmProvider(pluginCtx, { load: () => Promise.resolve(CATALOG) })
      },
    })
    await adapter?.ready
    expect((await ctx.llm.listModels('cpa')).length).toBeGreaterThan(0)
    await fiber.dispose()
    await expect(ctx.llm.listModels('cpa')).rejects.toThrow()
  })

  it('offers all seven OMP thinking levels to selectors', () => {
    expect(OMP_REASONING_EFFORTS.map(effort => effort.id))
      .toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })
})
