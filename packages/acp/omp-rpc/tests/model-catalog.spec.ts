import { describe, expect, it } from 'vitest'
import { loadOmpModelCatalog, type OmpCatalogSourceOptions } from '../src/model-catalog.ts'

const ROWS = {
  models: [
    {
      provider: 'cpa',
      kind: 'chat',
      id: 'gemini-4-argon-high',
      name: 'Gemini 4 Argon',
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      input: ['text', 'image'],
      thinking: ['low', 'medium', 'high'],
    },
    {
      provider: 'opencode-go',
      id: 'deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      reasoning: true,
      thinking: ['low', 'high', 'max'],
      input: ['text', 'image'],
    },
    {
      provider: 'openai-codex',
      id: 'gpt-6.1-sol',
      name: 'GPT-6.1 Sol',
      contextWindow: 400_000,
      thinking: ['minimal', 'low', 'medium', 'high'],
    },
    {
      provider: 'google-antigravity',
      id: 'gemini-4-argon-high',
      thinking: null,
    },
    {
      provider: 'cpa',
      id: 'broken-row',
      name: '',
      contextWindow: -1,
      thinking: ['ultra'],
    },
  ],
}

const MODELS_YAML = `
providers:
  cpa:
    modelOverrides:
      gemini-4-argon-high:
        thinking:
          defaultLevel: medium
`

const CONFIG_YAML = `
modelRoles:
  default: "opencode-go/deepseek-v4.1-flash:max"
  builder: opencode-go/deepseek-v4.1-flash:max
  plan: openai-codex/gpt-6.1-sol:high
  smol: cpa/gemini-4-argon-high:high
  web: web/duckduckgo
`

function source(overrides: Partial<OmpCatalogSourceOptions> = {}): OmpCatalogSourceOptions {
  return {
    executable: '/opt/omp/bin/omp',
    home: '/home/tester',
    cwd: '/work',
    run: () => Promise.resolve(JSON.stringify(ROWS)),
    readText: async (path) => {
      if (path.endsWith('models.yml')) return MODELS_YAML
      if (path.endsWith('config.yml')) return CONFIG_YAML
      throw new Error(`unexpected read: ${path}`)
    },
    ...overrides,
  }
}

describe('OMP catalog source', () => {
  it('keeps every authenticated provider instead of collapsing to the CPA route', async () => {
    const catalog = await loadOmpModelCatalog(source())
    expect(catalog.models.map(model => model.provider)).toEqual([
      'cpa',
      'opencode-go',
      'openai-codex',
      'google-antigravity',
      'cpa',
    ])
  })

  it('reads context, output cap, modalities, and the per-model thinking ladder', async () => {
    const catalog = await loadOmpModelCatalog(source())
    const flash = catalog.models.find(model => model.id === 'deepseek-v4.1-flash')
    expect(flash).toMatchObject({
      provider: 'opencode-go',
      name: 'DeepSeek V4.1 Flash',
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      inputModalities: ['text', 'image'],
      thinkingLevels: ['low', 'high', 'max'],
    })
    expect(catalog.models.find(model => model.id === 'gpt-6.1-sol')?.thinkingLevels)
      .toEqual(['minimal', 'low', 'medium', 'high'])
  })

  it('restores the default thinking level models.yml declares', async () => {
    const catalog = await loadOmpModelCatalog(source())
    expect(catalog.models.find(model => model.provider === 'cpa' && model.id === 'gemini-4-argon-high'))
      .toMatchObject({ thinkingLevels: ['low', 'medium', 'high'], defaultThinkingLevel: 'medium' })
    expect(catalog.models.find(model => model.id === 'deepseek-v4.1-flash')?.defaultThinkingLevel).toBe('high')
  })

  it('attaches every configured role that resolves to the model', async () => {
    const catalog = await loadOmpModelCatalog(source())
    expect(catalog.models.find(model => model.id === 'deepseek-v4.1-flash')?.roles).toEqual(['default', 'builder'])
    expect(catalog.models.find(model => model.id === 'gpt-6.1-sol')?.roles).toEqual(['plan'])
    expect(catalog.models.find(model => model.id === 'gemini-4-argon-high')?.roles.length).toBeGreaterThan(0)
  })

  it('normalizes rows without inventing metadata', async () => {
    const catalog = await loadOmpModelCatalog(source())
    expect(catalog.models.find(model => model.id === 'broken-row')).toMatchObject({
      provider: 'cpa',
      name: 'Broken Row',
      thinkingLevels: [],
      roles: [],
    })
    expect(catalog.models.find(model => model.id === 'broken-row')?.contextWindow).toBeUndefined()
    expect(catalog.models.find(model => model.provider === 'google-antigravity'))
      .toMatchObject({ name: 'Gemini 4 Argon High', thinkingLevels: [], roles: [] })
  })

  it('runs the structured catalog command in the requested working directory', async () => {
    const calls: { executable: string; args: readonly string[]; cwd: string; timeoutMs: number }[] = []
    await loadOmpModelCatalog(source({
      timeoutMs: 1234,
      run: (executable, args, cwd, timeoutMs) => {
        calls.push({ executable, args, cwd, timeoutMs })
        return Promise.resolve(JSON.stringify(ROWS))
      },
    }))
    expect(calls).toEqual([{
      executable: '/opt/omp/bin/omp',
      args: ['models', '--json'],
      cwd: '/work',
      timeoutMs: 1234,
    }])
  })

  it('ignores unreadable local documents and still serves the authenticated list', async () => {
    const catalog = await loadOmpModelCatalog(source({
      readText: path => Promise.reject(new Error(`missing ${path}`)),
    }))
    expect(catalog.models).toHaveLength(ROWS.models.length)
    expect(catalog.models.every(model => model.roles.length === 0)).toBe(true)
  })

  it('ignores malformed local documents instead of failing the catalog', async () => {
    const catalog = await loadOmpModelCatalog(source({
      readText: () => Promise.resolve('modelRoles: [unclosed'),
    }))
    expect(catalog.models.find(model => model.id === 'deepseek-v4.1-flash')?.roles).toEqual([])
  })

  it('rejects when the catalog command fails', async () => {
    await expect(loadOmpModelCatalog(source({
      run: () => Promise.reject(new Error('omp exited 1')),
    }))).rejects.toThrow('omp exited 1')
  })
})
