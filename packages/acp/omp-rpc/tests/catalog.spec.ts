import { describe, expect, it } from 'vitest'
import {
  applyOperatorSelection,
  matchCatalogModel,
  mintModel,
  OmpModelSelectionError,
  readActiveModel,
  readAuthority,
} from '../src/catalog.ts'
import type { OmpRpcCommand } from '../src/types.ts'

/** The catalog the scripted gateway advertises. */
const CATALOG = {
  models: [
    { id: 'go/glm-5', name: 'GLM 5', provider: 'opencode-go' },
    { id: 'gpt-5.5', name: 'GPT-5.5' },
  ],
}

interface ScriptedState {
  provider: string
  id: string
  thinkingLevel?: string
}

/** An OMP gateway whose session state follows the writes it accepts. */
class ScriptedClient {
  readonly commands: OmpRpcCommand[] = []
  readonly reject: readonly string[]
  state: ScriptedState
  /** Accept every write without changing state, as a gateway that ignores it would. */
  frozen = false

  constructor(options: { state: ScriptedState; reject?: readonly string[] }) {
    this.state = options.state
    this.reject = options.reject ?? []
  }

  request(command: OmpRpcCommand): Promise<unknown> {
    this.commands.push(command)
    if (this.reject.includes(command.type)) {
      return Promise.reject(new Error(`${command.type} was rejected`))
    }
    switch (command.type) {
      case 'get_available_models': return Promise.resolve(CATALOG)
      case 'get_state':
        return Promise.resolve({
          sessionId: 's1',
          model: { provider: this.state.provider, id: this.state.id },
          ...this.state.thinkingLevel === undefined ? {} : { thinkingLevel: this.state.thinkingLevel },
        })
      case 'set_model':
        if (!this.frozen) {
          this.state = { ...this.state, provider: String(command['provider']), id: String(command['modelId']) }
        }
        return Promise.resolve({})
      case 'set_thinking_level':
        if (!this.frozen) this.state = { ...this.state, thinkingLevel: String(command['level']) }
        return Promise.resolve({})
      default: return Promise.resolve({})
    }
  }
}

describe('matchCatalogModel', () => {
  it('prefers an exact id and falls back to a route-prefixed id', () => {
    const models = [
      { id: 'cpa/claude-opus-4-6', provider: 'cpa' },
      { id: 'glm-5', provider: 'opencode-go' },
    ]
    expect(matchCatalogModel(models, { provider: 'llm-pi-ai', model: 'glm-5' })).toEqual({ id: 'glm-5', provider: 'opencode-go' })
    expect(matchCatalogModel(models, { provider: 'llm-pi-ai', model: 'claude-opus-4-6' }))
      .toEqual({ id: 'cpa/claude-opus-4-6', provider: 'cpa' })
    expect(matchCatalogModel(models, { provider: 'llm-pi-ai', model: 'absent' })).toBeUndefined()
  })
})

describe('readActiveModel', () => {
  it('reads the route, model, and effective thinking level the process reports', () => {
    expect(readActiveModel({
      sessionId: 's1',
      model: { provider: 'cpa', id: 'claude-opus-4-6' },
      thinkingLevel: 'high',
    })).toEqual({ provider: 'cpa', model: 'claude-opus-4-6', thinkingLevel: 'high' })
  })

  it('reads a delegated selector as no explicit effort', () => {
    expect(readActiveModel({ model: { provider: 'cpa', id: 'claude-opus-4-6' }, thinkingLevel: 'inherit' }))
      .toEqual({ provider: 'cpa', model: 'claude-opus-4-6' })
    expect(readActiveModel({ model: { provider: 'cpa', id: 'claude-opus-4-6' }, thinkingLevel: 'auto' }))
      .toEqual({ provider: 'cpa', model: 'claude-opus-4-6' })
  })

  it('rejects a payload without a model', () => {
    expect(readActiveModel({ sessionId: 's1' })).toBeUndefined()
    expect(readActiveModel({ model: { provider: '', id: 'x' } })).toBeUndefined()
    expect(readActiveModel(undefined)).toBeUndefined()
  })
})

describe('readAuthority', () => {
  it('reads the process authority and never writes to it', async () => {
    const client = new ScriptedClient({ state: { provider: 'cpa', id: 'claude-opus-4-6', thinkingLevel: 'high' } })

    await expect(readAuthority(client)).resolves.toEqual({
      active: { provider: 'cpa', model: 'claude-opus-4-6', thinkingLevel: 'high' },
      models: CATALOG.models,
    })
    expect(client.commands.map(command => command.type)).toEqual(['get_available_models', 'get_state'])
  })

  it('reads an already-fetched state without asking the process again', async () => {
    const client = new ScriptedClient({ state: { provider: 'cpa', id: 'claude-opus-4-6' } })

    await readAuthority(client, { sessionId: 's1', model: { provider: 'cpa', id: 'claude-opus-4-6' } })
    expect(client.commands.map(command => command.type)).toEqual(['get_available_models'])
  })

  it('reads an absent or malformed catalog as empty rather than throwing', async () => {
    const client = new ScriptedClient({ state: { provider: 'cpa', id: 'claude-opus-4-6' } })
    client.request = () => Promise.resolve({ models: 'nonsense' })

    await expect(readAuthority(client)).resolves.toMatchObject({ models: [] })
  })
})

describe('mintModel', () => {
  it('mints an explicit selection and reports the authority the process adopted', async () => {
    const client = new ScriptedClient({ state: { provider: 'cpa', id: 'claude-opus-4-6' } })

    const outcome = await mintModel(client, { provider: 'llm-pi-ai', model: 'glm-5', reasoningEffort: 'high' })
    expect(outcome.status).toBe('applied')
    expect(outcome.active).toEqual({ provider: 'opencode-go', model: 'go/glm-5', thinkingLevel: 'high' })
    expect(client.commands).toEqual([
      { type: 'get_available_models' },
      { type: 'get_state' },
      { type: 'set_model', provider: 'opencode-go', modelId: 'go/glm-5' },
      { type: 'set_thinking_level', level: 'high' },
      { type: 'get_state' },
    ])
  })

  it('reports a mint the gateway does not offer and writes nothing', async () => {
    const client = new ScriptedClient({ state: { provider: 'cpa', id: 'claude-opus-4-6' } })

    await expect(mintModel(client, { provider: 'llm-pi-ai', model: 'meridian-only' })).resolves.toEqual({
      status: 'not-offered',
      active: { provider: 'cpa', model: 'claude-opus-4-6' },
      models: CATALOG.models,
    })
    expect(client.commands.map(command => command.type)).toEqual(['get_available_models', 'get_state'])
  })
})

describe('applyOperatorSelection', () => {
  it('sends both commands and returns the authority the process confirms', async () => {
    const client = new ScriptedClient({ state: { provider: 'cpa', id: 'claude-opus-4-6', thinkingLevel: 'low' } })

    await expect(applyOperatorSelection(client, { provider: 'llm-pi-ai', model: 'glm-5', reasoningEffort: 'high' }))
      .resolves.toEqual({ provider: 'opencode-go', model: 'go/glm-5', thinkingLevel: 'high' })
    expect(client.commands).toEqual([
      { type: 'get_available_models' },
      { type: 'set_model', provider: 'opencode-go', modelId: 'go/glm-5' },
      { type: 'set_thinking_level', level: 'high' },
      { type: 'get_state' },
    ])
  })

  it('defers the effort to the process when the operator picked none', async () => {
    const client = new ScriptedClient({ state: { provider: 'cpa', id: 'claude-opus-4-6' } })

    await applyOperatorSelection(client, { provider: 'cpa', model: 'gpt-5.5' })
    expect(client.commands).toContainEqual({ type: 'set_thinking_level', level: 'inherit' })
  })

  it('fails closed when the process rejects the thinking level', async () => {
    const client = new ScriptedClient({
      state: { provider: 'cpa', id: 'claude-opus-4-6', thinkingLevel: 'low' },
      reject: ['set_thinking_level'],
    })

    const failure = await applyOperatorSelection(client, { provider: 'cpa', model: 'gpt-5.5', reasoningEffort: 'high' })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(OmpModelSelectionError)
    expect(failure).toMatchObject({ code: 'rejected' })
    expect(String(failure)).toContain('set_thinking_level')
  })

  it('fails closed when the process reports a model it never adopted', async () => {
    const client = new ScriptedClient({ state: { provider: 'cpa', id: 'claude-opus-4-6' } })
    client.frozen = true

    await expect(applyOperatorSelection(client, { provider: 'cpa', model: 'gpt-5.5', reasoningEffort: 'high' }))
      .rejects.toMatchObject({ code: 'unverified' })
  })

  it('fails closed without writing when the gateway does not serve the model', async () => {
    const client = new ScriptedClient({ state: { provider: 'cpa', id: 'claude-opus-4-6' } })

    await expect(applyOperatorSelection(client, { provider: 'cpa', model: 'meridian-only' }))
      .rejects.toMatchObject({ code: 'not-offered' })
    expect(client.commands.map(command => command.type)).toEqual(['get_available_models'])
  })
})
