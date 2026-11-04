import { describe, expect, it } from 'vitest'
import {
  CLIENT_OWNED_COMMANDS,
  OMP_NATIVE_COMMANDS,
  ompNativeCommandCatalog,
  ompNativeCommandLine,
  ompSkillCommands,
  parseOmpSkillListing,
} from '../src/native-commands.ts'

describe('OMP native command catalog', () => {
  it('seeds the real OMP builtins a fresh session serves', () => {
    const names = ompNativeCommandCatalog().map(command => command.name)
    expect(names).toContain('compact')
    expect(names).toContain('security')
    expect(names).toContain('reload-plugins')
    expect(names).not.toContain('omp')
  })

  it('projects visible skills onto /skill: command names', () => {
    expect(ompSkillCommands([
      { name: 'fold-adb', description: 'Galaxy Fold adb tasks' },
      { name: 'fresh', description: 'Open files in VS Code' },
    ])).toEqual([
      { name: 'skill:fold-adb', description: 'Galaxy Fold adb tasks', hint: 'arguments', source: 'skill' },
      { name: 'skill:fresh', description: 'Open files in VS Code', hint: 'arguments', source: 'skill' },
    ])
  })

  it('drops hidden skills from the command surface', () => {
    expect(ompSkillCommands([{ name: 'secret', hide: true }])).toEqual([])
  })

  it('never shadows a command whose receiving client owns the interaction', () => {
    expect(OMP_NATIVE_COMMANDS.some(command => command.name === 'model')).toBe(false)
    expect(CLIENT_OWNED_COMMANDS.model).toBe(true)
    const catalog = ompNativeCommandCatalog([{ name: 'model' }])
    expect(catalog.some(command => command.name === 'model')).toBe(false)
    expect(catalog.some(command => command.name === 'skill:model')).toBe(true)
  })

  it('renders the exact slash line OMP resolves', () => {
    expect(ompNativeCommandLine('status', '')).toBe('/status')
    expect(ompNativeCommandLine('status', '  now ')).toBe('/status now')
    expect(ompNativeCommandLine('skill:fold-adb', ' install ')).toBe('/skill:fold-adb install')
  })
})

describe('OMP skill listing', () => {
  it('reads visible and hidden rows in listing order', () => {
    expect(parseOmpSkillListing(JSON.stringify({
      skills: [
        { name: 'alpha', description: 'First', source: 'project' },
        { name: 'beta', hide: true },
      ],
    }))).toEqual([
      { name: 'alpha', description: 'First', source: 'project' },
      { name: 'beta', hide: true },
    ])
  })

  it('rejects a listing without a skills array', () => {
    expect(() => parseOmpSkillListing('{"rows":[]}')).toThrow(/no `skills` array/)
  })

  it('drops malformed rows instead of failing the listing', () => {
    expect(parseOmpSkillListing(JSON.stringify({ skills: [{}, { name: '' }, { name: 'kept' }] }))).toEqual([
      { name: 'kept' },
    ])
  })
})
