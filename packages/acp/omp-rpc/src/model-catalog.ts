/**
 * Live OMP model catalog: every authenticated provider and the metadata its
 * selectors need. `omp models --json` resolves the authenticated registry and
 * `models.yml` into one list; `models.yml` still holds the per-model default
 * thinking level the list flattens away, and `config.yml` holds the role
 * selectors that become selector badges.
 *
 * @module @deepseek-ai/dsh-omp-rpc/model-catalog
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parse as parseYaml } from 'yaml'

const runFile = promisify(execFile)

/** Thinking levels OMP accepts, least to greatest. */
export const OMP_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** One OMP thinking level. */
export type OmpThinkingLevel = typeof OMP_THINKING_LEVELS[number]

/** Input modalities the harness model catalog can represent. */
export type OmpInputModality = 'text' | 'image'

/** Display order for role badges shared by every OMP surface. */
const ROLE_ORDER = [
  'default',
  'smol',
  'slow',
  'vision',
  'plan',
  'commit',
  'tiny',
  'memory',
  'task',
  'advisor',
  'judge',
] as const

/** One authenticated model OMP reports. */
export interface OmpCatalogModel {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly contextWindow?: number
  readonly maxTokens?: number
  readonly inputModalities?: readonly OmpInputModality[]
  readonly thinkingLevels: readonly OmpThinkingLevel[]
  readonly defaultThinkingLevel?: OmpThinkingLevel
  /** Configured OMP roles that resolve to this exact model, in display order. */
  readonly roles: readonly string[]
}

/** One resolved snapshot of OMP's authenticated catalog. */
export interface OmpModelCatalogSnapshot {
  readonly models: readonly OmpCatalogModel[]
}

/** Injection seams for deterministic catalog tests. */
export interface OmpCatalogSourceOptions {
  /** OMP executable name or absolute path. */
  readonly executable: string
  /** OMP home holding `agent/models.yml` and `agent/config.yml`; defaults to `$HOME`. */
  readonly home?: string
  /** Directory OMP resolves config and model discovery from; defaults to the process cwd. */
  readonly cwd?: string
  /** Deadline for one catalog command; defaults to 15 seconds. */
  readonly timeoutMs?: number
  /** Runs one OMP command and returns its stdout. */
  readonly run?: (executable: string, args: readonly string[], cwd: string, timeoutMs: number) => Promise<string>
  /** Reads one UTF-8 file. */
  readonly readText?: (path: string) => Promise<string>
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function displayName(id: string): string {
  const words = id.split(/[-_.]/u).filter(word => word.length > 0)
  if (words.length === 0) return id
  return words
    .map(word => word[0] === undefined ? word : `${word[0].toUpperCase()}${word.slice(1)}`)
    .join(' ')
}

function isThinkingLevel(value: unknown): value is OmpThinkingLevel {
  return OMP_THINKING_LEVELS.some(level => level === value)
}

function thinkingLevelsOf(value: unknown): OmpThinkingLevel[] {
  const efforts = recordOf(value)?.['efforts']
  const listed = Array.isArray(value) ? value : Array.isArray(efforts) ? efforts : []
  const seen = new Set<OmpThinkingLevel>()
  for (const entry of listed) {
    if (isThinkingLevel(entry)) seen.add(entry)
  }
  return OMP_THINKING_LEVELS.filter(level => seen.has(level))
}

function inputModalitiesOf(value: unknown): OmpInputModality[] | undefined {
  if (!Array.isArray(value)) return undefined
  const modalities: OmpInputModality[] = []
  for (const entry of value) {
    if (entry === 'text' || entry === 'image') modalities.push(entry)
  }
  return modalities.length === 0 ? undefined : modalities
}

function withoutThinkingSuffix(selector: string): string {
  const colon = selector.lastIndexOf(':')
  if (colon === -1) return selector
  return isThinkingLevel(selector.slice(colon + 1)) ? selector.slice(0, colon) : selector
}

function roleOrder(role: string): number {
  const index = ROLE_ORDER.findIndex(known => known === role)
  return index === -1 ? ROLE_ORDER.length : index
}

function rolesBySelector(config: unknown): Map<string, string[]> {
  const roles = new Map<string, string[]>()
  const modelRoles = recordOf(recordOf(config)?.['modelRoles'])
  if (modelRoles === undefined) return roles
  const entries = Object.entries(modelRoles)
    .flatMap(([role, value]) => {
      const selector = nonEmptyString(value)
      if (selector === undefined || !selector.includes('/')) return []
      if (selector.startsWith('@') || selector.startsWith('*')) return []
      return [{ role, selector: withoutThinkingSuffix(selector) }]
    })
    .sort((left, right) => roleOrder(left.role) - roleOrder(right.role)
      || left.role.localeCompare(right.role, 'en'))
  for (const { role, selector } of entries) {
    const known = roles.get(selector) ?? []
    known.push(role)
    roles.set(selector, known)
  }
  return roles
}

function defaultThinkingLevels(models: unknown): Map<string, OmpThinkingLevel> {
  const levels = new Map<string, OmpThinkingLevel>()
  const providers = recordOf(recordOf(models)?.['providers'])
  if (providers === undefined) return levels
  for (const [provider, providerValue] of Object.entries(providers)) {
    const overrides = recordOf(recordOf(providerValue)?.['modelOverrides'])
    if (overrides === undefined) continue
    for (const [id, overrideValue] of Object.entries(overrides)) {
      const defaultLevel = nonEmptyString(recordOf(recordOf(overrideValue)?.['thinking'])?.['defaultLevel'])
      if (defaultLevel === undefined) continue
      const level = OMP_THINKING_LEVELS.find(candidate => candidate === defaultLevel)
      if (level !== undefined) levels.set(`${provider}/${id}`, level)
    }
  }
  return levels
}

function modelRows(stdout: string): readonly unknown[] {
  const parsed = JSON.parse(stdout) as unknown
  const models = recordOf(parsed)?.['models']
  if (!Array.isArray(models)) throw new Error('omp models --json returned no "models" array')
  return models
}

function normalize(
  rows: readonly unknown[],
  roles: ReadonlyMap<string, readonly string[]>,
  defaults: ReadonlyMap<string, OmpThinkingLevel>,
): OmpCatalogModel[] {
  const models: OmpCatalogModel[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const record = recordOf(row)
    if (record === undefined) continue
    const provider = nonEmptyString(record['provider'])
    const id = nonEmptyString(record['id'])
    if (provider === undefined || id === undefined) continue
    const key = `${provider}/${id}`
    if (seen.has(key)) continue
    seen.add(key)
    const contextWindow = positiveNumber(record['contextWindow'])
    const maxTokens = positiveNumber(record['maxTokens'])
    const inputModalities = inputModalitiesOf(record['input'])
    const thinkingLevels = thinkingLevelsOf(record['thinking'])
    const reportedDefault = nonEmptyString(record['defaultThinkingLevel'])
      ?? nonEmptyString(recordOf(record['thinking'])?.['defaultLevel'])
    const declaredDefault = isThinkingLevel(reportedDefault) ? reportedDefault : defaults.get(key)
    const defaultThinkingLevel = declaredDefault
      ?? (thinkingLevels.includes('high') ? 'high' : thinkingLevels.at(-1))
    models.push({
      provider,
      id,
      name: nonEmptyString(record['name']) ?? displayName(id),
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...inputModalities === undefined ? {} : { inputModalities },
      thinkingLevels,
      ...defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel },
      roles: roles.get(key) ?? [],
    })
  }
  return models
}

async function optionalText(readText: (path: string) => Promise<string>, path: string): Promise<string | undefined> {
  try {
    return await readText(path)
  } catch {
    return undefined
  }
}

async function optionalYaml(readText: (path: string) => Promise<string>, path: string): Promise<unknown> {
  const text = await optionalText(readText, path)
  if (text === undefined) return undefined
  try {
    return parseYaml(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * Resolve OMP's authenticated provider and model catalog.
 *
 * The command is the only authority on which providers are authenticated; the
 * two local documents only restore what the flattened command output drops.
 * @param options - executable, OMP home, and injection seams.
 * @returns every authenticated model grouped by its real provider.
 * @throws when the OMP catalog command fails or returns no model list.
 */
export async function loadOmpModelCatalog(options: OmpCatalogSourceOptions): Promise<OmpModelCatalogSnapshot> {
  const cwd = options.cwd ?? process.cwd()
  const timeoutMs = options.timeoutMs ?? 15_000
  const run = options.run ?? (async (executable, args, directory, timeout) => {
    const { stdout } = await runFile(executable, [...args], {
      cwd: directory,
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    })
    return stdout
  })
  const readText = options.readText ?? (path => readFile(path, 'utf8'))
  const agentHome = join(options.home ?? process.env['HOME'] ?? '.', '.omp', 'agent')
  const [stdout, modelsDocument, configDocument] = await Promise.all([
    run(options.executable, ['models', '--json'], cwd, timeoutMs),
    optionalYaml(readText, join(agentHome, 'models.yml')),
    optionalYaml(readText, join(agentHome, 'config.yml')),
  ])
  return {
    models: normalize(modelRows(stdout), rolesBySelector(configDocument), defaultThinkingLevels(modelsDocument)),
  }
}
