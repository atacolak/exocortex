import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError, type LlmAdapter, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import {
  OMP_LLM_MODELS,
  OMP_LLM_PROVIDER,
  OmpLlmProvider,
  registerOmpLlmProvider,
} from '../src/llm-catalog.ts'

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  return ctx
}

describe('OMP metadata route identity', () => {
  it('owns the same provider id the profile default model configures', () => {
    expect(OMP_LLM_PROVIDER).toBe('cpa')
    expect(new OmpLlmProvider().provider).toBe('cpa')
  })

  it('advertises the reasoning efforts the CPA route serves, without a Default entry', async () => {
    const provider = new OmpLlmProvider()
    const resolved = await provider.resolveModel('cpa', 'gemini-4-argon-high')
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'low', 'medium', 'high', 'xhigh'])
    expect(resolved.reasoning?.efforts.some(effort => effort.name === 'Default')).toBe(false)
    expect(resolved.reasoning?.defaultEffort).toBe('high')
  })

  it('keeps text and image input and the argon context window', async () => {
    const provider = new OmpLlmProvider()
    const resolved = await provider.resolveModel('cpa', 'gemini-4-argon-high')
    expect(resolved.inputModalities).toEqual(['text', 'image'])
    expect(resolved.context).toEqual({ contextWindow: 1_048_576 })
  })

  it('serves every advertised model through the same capability contract', async () => {
    const provider = new OmpLlmProvider()
    for (const spec of OMP_LLM_MODELS) {
      const resolved = await provider.resolveModel('cpa', spec.id)
      expect(resolved.provider).toBe('cpa')
      expect(resolved.id).toBe(spec.id)
      expect(resolved.inputModalities).toEqual(['text', 'image'])
      expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'low', 'medium', 'high', 'xhigh'])
    }
  })

  it('exposes a discovered OMP model id with the same metadata shape', async () => {
    const provider = new OmpLlmProvider('cpa')
    provider.observe(['gpt-6.1-sol', 'x-custom-route'])
    const resolved = await provider.resolveModel('cpa', 'x-custom-route')
    expect(resolved.name).toBe('X Custom Route')
    expect(resolved.inputModalities).toEqual(['text', 'image'])
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'low', 'medium', 'high', 'xhigh'])
    expect((await provider.listModels('cpa')).map(model => model.id)).toContain('gpt-6.1-sol')
  })
})

describe('OMP metadata route registration', () => {
  it('registers on a Cordis context and validates exact model metadata', async () => {
    const ctx = await harness()
    registerOmpLlmProvider(ctx)

    const info = await ctx.llm.resolveModelInfo('cpa', 'gemini-4-argon-high')
    expect(info).toMatchObject({ provider: 'cpa', id: 'gemini-4-argon-high' })
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'low', 'medium', 'high', 'xhigh'])
    expect(info.inputModalities).toEqual(['text', 'image'])

    const catalog = await ctx.llm.listModels('cpa')
    expect(catalog.map(model => model.id)).toEqual(OMP_LLM_MODELS.map(spec => spec.id))
  })

  it('refuses a direct dispatch instead of speaking a second protocol', async () => {
    const provider = new OmpLlmProvider('cpa')
    const request: GenerateOptions = {
      provider: 'cpa',
      model: 'gemini-4-argon-high',
      messages: [],
    }
    await expect(async () => {
      for await (const _chunk of provider.stream(request)) { /* unreachable */ }
    }).rejects.toBeInstanceOf(LlmError)
  })

  it('releases the route when the registering context is disposed', async () => {
    const ctx = await harness()
    const fiber = await ctx.plugin({
      name: 'omp-rpc llm catalog',
      inject: ['llm'],
      apply(pluginCtx: Context) { registerOmpLlmProvider(pluginCtx) },
    })
    expect((await ctx.llm.listModels('cpa')).length).toBeGreaterThan(0)
    await fiber.dispose()
    await expect(ctx.llm.listModels('cpa')).rejects.toThrow()
  })
})

describe('OMP metadata route adapter shape', () => {
  it('is an LlmAdapter so the host catalog can own it', () => {
    const provider: LlmAdapter = new OmpLlmProvider()
    expect(provider.providerInfo('cpa')).toEqual({ id: 'cpa', name: 'OMP (CPA Proxy)' })
  })
})
