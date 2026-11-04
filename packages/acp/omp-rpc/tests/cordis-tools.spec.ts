import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it } from 'vitest'
import { DEFAULT_OMP_HOST_TOOLS, ompCordisHostTools, ompHostToolDefinition } from '../src/cordis-tools.ts'

describe('ompHostToolDefinition', () => {
  it('publishes Cordis tools as discoverable host tools', () => {
    expect(ompHostToolDefinition({
      name: 'cordis_inspect_list',
      description: 'List runtime providers',
      parameters: { type: 'object', properties: {} },
    })).toEqual({
      name: 'cordis_inspect_list',
      label: 'cordis_inspect_list',
      description: 'List runtime providers',
      parameters: { type: 'object', properties: {} },
      loadMode: 'discoverable',
    })
  })
})

describe('DEFAULT_OMP_HOST_TOOLS', () => {
  it('publishes the dynamic Cordis and workbench tool surface', () => {
    expect([...DEFAULT_OMP_HOST_TOOLS]).toEqual([
      'cordis_inspect_list',
      'cordis_inspect_query',
      'cordis_inspect_self',
      'cordis_define',
      'cordis_run',
      'cordis_stop',
      'cordis_undefine',
      'plugin_manager',
      'plugin_steward',
      'exo_workbench',
    ])
  })

  it('skips names a profile does not mount and publishes the rest', () => {
    const ctx = new Context()
    const definitions = ['cordis_define', 'cordis_run', 'exo_workbench'].map(name => ({
      name,
      description: `${name} description`,
      parameters: { type: 'object', properties: {} },
    }))
    ctx.provide('tools', { definitions: () => definitions } as never)
    const handlers = ompCordisHostTools({
      ctx,
      agent: { id: 'session-1' } as Agent,
      names: DEFAULT_OMP_HOST_TOOLS,
    })
    expect(handlers.map(handler => handler.definition.name)).toEqual([
      'cordis_define',
      'cordis_run',
      'exo_workbench',
    ])
    expect(handlers.every(handler => handler.definition.loadMode === 'discoverable')).toBe(true)
  })
})
