import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { OmpCompactCommand } from './types.ts'

/** One slash command OMP advertises over its RPC surface. */
export interface OmpNativeCommand {
  /** Command name without the leading slash; skills carry OMP's `skill:` prefix. */
  readonly name: string
  readonly description?: string
  /** Arguments hint shown by command palettes. */
  readonly hint?: string
  readonly source?: string
}

/** One skill row as `omp skill list --json` publishes it. */
export interface OmpSkillListing {
  readonly name: string
  readonly description?: string
  readonly hide?: boolean
  readonly source?: string
}

/**
 * OMP builtin slash commands, mirroring `get_available_commands` for a fresh
 * session. Live discovery stays authoritative: attach-time registration adds
 * every extension, custom, and file command this seed does not name, and
 * `available_commands_update` frames extend it while the session runs.
 */
export const OMP_NATIVE_COMMANDS: readonly OmpNativeCommand[] = [
  { name: 'security', description: 'Plan, run, inspect, import, and compare OMP-native security scans', hint: '<plan|scan|status|cancel|scans|show|import|export|validate|compare|disposition>', source: 'builtin' },
  { name: 'switch', description: 'Switch model for this session only', hint: '[model]', source: 'builtin' },
  { name: 'fast', description: 'Toggle fast mode', hint: '[on|ultra|off|status]', source: 'builtin' },
  { name: 'slow', description: 'Toggle slow mode', hint: '[on|off|status]', source: 'builtin' },
  { name: 'skillful', description: 'Toggle skill listing', hint: '[on|off|status]', source: 'builtin' },
  { name: 'extended-context', description: 'Toggle extended context', hint: '[on|off|status]', source: 'builtin' },
  { name: 'computer', description: 'Toggle computer use', hint: '[on|off|status]', source: 'builtin' },
  { name: 'ratchet', description: 'Build (or reuse) an eval for an LLM flow, then hillclimb it unattended', hint: '[flow and goal]', source: 'builtin' },
  { name: 'prewalk', description: 'Arm, restart, or cancel prewalk', hint: '[into] | restart [from] [into] | off', source: 'builtin' },
  { name: 'modelpreset', description: 'Manage model presets', hint: '[list|save|switch|delete] [name]', source: 'builtin' },
  { name: 'effort', description: 'Set or show reasoning effort (thinking level, intelligence)', hint: '[level]', source: 'builtin' },
  { name: 'advisor', description: 'Toggle advisor', hint: '[on|off|status|dump [raw]|configure]', source: 'builtin' },
  { name: 'export', description: 'Export session to HTML file', hint: '[--themes] [path]', source: 'builtin' },
  { name: 'trace', description: "Open this session's trace in the stats dashboard", source: 'builtin' },
  { name: 'dump', description: 'Return full transcript as plain text, with LLM request JSON path', hint: '[all|anon]', source: 'builtin' },
  { name: 'share', description: 'Share session via an encrypted link (share server or secret gist)', source: 'builtin' },
  { name: 'browser', description: 'Toggle browser eval-prelude headless vs visible mode', hint: '[headless|visible]', source: 'builtin' },
  { name: 'todo', description: 'Manage todos', hint: '<subcommand>', source: 'builtin' },
  { name: 'session', description: 'Show or configure the current session', hint: '[info|delete|pin [account]]', source: 'builtin' },
  { name: 'jobs', description: 'Show background jobs', hint: '[full|kill <id>|kill all]', source: 'builtin' },
  { name: 'usage', description: 'Show token usage', hint: '[show|reset [provider/credential-id|provider/active]]', source: 'builtin' },
  { name: 'stats', description: 'Launch the local stats dashboard', hint: '[--port <port>] [--host <host>]', source: 'builtin' },
  { name: 'changelog', description: 'Show changelog', hint: '[full|last [N]]', source: 'builtin' },
  { name: 'tools', description: 'Show available tools', source: 'builtin' },
  { name: 'context', description: 'Show context usage', source: 'builtin' },
  { name: 'mcp', description: 'Manage MCP servers', hint: '<subcommand>', source: 'builtin' },
  { name: 'ssh', description: 'Manage SSH connections', hint: '<subcommand>', source: 'builtin' },
  { name: 'fresh', description: 'Reset provider stream state without changing the local transcript', source: 'builtin' },
  { name: 'compact', description: 'Compact the conversation', hint: '[soft|remote|snapcompact] [focus]', source: 'builtin' },
  { name: 'shake', description: 'Shake heavy content out of the conversation context', hint: '[elide|images|thinking]', source: 'builtin' },
  { name: 'handoff', description: 'Summarize the session into a handoff document and compact in place', hint: '[focus instructions]', source: 'builtin' },
  { name: 'pin', description: 'Pin or unpin a session at the top of the resume list', hint: '[session id]', source: 'builtin' },
  { name: 'retry', description: 'Retry the last failed agent turn', source: 'builtin' },
  { name: 'memory', description: 'Manage memory', hint: '<subcommand>', source: 'builtin' },
  { name: 'rename', description: 'Rename the current session (omit title to generate)', hint: '[title]', source: 'builtin' },
  { name: 'move', description: 'Move the current session to a different directory', hint: '[<path>]', source: 'builtin' },
  { name: 'wt', description: 'Move this session into a new worktree, changes included', hint: '[<branch>]', source: 'builtin' },
  { name: 'add-dir', description: 'Add a workspace directory to this session', hint: '<path>', source: 'builtin' },
  { name: 'remove-dir', description: 'Remove a workspace directory from this session', hint: '<path>', source: 'builtin' },
  { name: 'dirs', description: "List this session's workspace directories", source: 'builtin' },
  { name: 'marketplace', description: 'Manage plugins from marketplaces', hint: '<subcommand>', source: 'builtin' },
  { name: 'plugins', description: 'Manage plugins', hint: '[list|enable|disable]', source: 'builtin' },
  { name: 'reload-plugins', description: 'Reload all plugins', source: 'builtin' },
  { name: 'force', description: 'Force next turn to use a specific tool', hint: '<tool-name> [prompt]', source: 'builtin' },
  { name: 'forget-approvals', description: 'Forget every file and folder approval Ask and remember has recorded', source: 'builtin' },
]

/** Commands whose receiving client owns the interaction, so the bridge never shadows them. */
export const CLIENT_OWNED_COMMANDS: Readonly<Record<string, true>> = { model: true }

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value === null || typeof value !== 'object' || Array.isArray(value)
    ? undefined
    : value as Record<string, unknown>
}

/**
 * Read the skill rows out of `omp skill list --json`.
 * @param text - complete stdout of the listing command.
 * @returns visible skills in listing order; malformed rows are dropped.
 */
export function parseOmpSkillListing(text: string): OmpSkillListing[] {
  const parsed: unknown = JSON.parse(text)
  const rows = recordOf(parsed)?.skills
  if (!Array.isArray(rows)) throw new Error('omp skill list returned no `skills` array')
  const skills: OmpSkillListing[] = []
  for (const row of rows) {
    const record = recordOf(row)
    if (record === undefined) continue
    const name = record.name
    if (typeof name !== 'string' || name.length === 0) continue
    skills.push({
      name,
      ...typeof record.description === 'string' ? { description: record.description } : {},
      ...record.hide === true ? { hide: true } : {},
      ...typeof record.source === 'string' ? { source: record.source } : {},
    })
  }
  return skills
}

/**
 * Project skills onto OMP's `/skill:<name>` command names.
 * @param skills - visible skill rows for the session working directory.
 * @returns command rows for every skill whose listing row is not hidden.
 */
export function ompSkillCommands(skills: readonly OmpSkillListing[]): OmpNativeCommand[] {
  return skills
    .filter(skill => skill.hide !== true)
    .map(skill => ({
      name: `skill:${skill.name}`,
      description: skill.description ?? `Run the ${skill.name} skill`,
      hint: 'arguments',
      source: 'skill',
    }))
}

/**
 * Compose the pre-attach command surface for one session.
 * @param skills - skill rows discovered for the session working directory.
 * @returns builtin and skill commands that are not client-owned.
 */
export function ompNativeCommandCatalog(skills: readonly OmpSkillListing[] = []): OmpNativeCommand[] {
  return [...OMP_NATIVE_COMMANDS, ...ompSkillCommands(skills)]
    .filter(command => CLIENT_OWNED_COMMANDS[command.name] !== true)
}

/**
 * Render one invocation as the exact line OMP's prompt surface resolves.
 * @param name - command name without the leading slash.
 * @param rawInput - invocation text following the command name.
 * @returns the slash-prefixed command line sent to OMP.
 */
export function ompNativeCommandLine(name: string, rawInput: string): string {
  const args = rawInput.trim()
  return `/${name}${args.length === 0 ? '' : ` ${args}`}`
}

/**
 * List the skills a session in `cwd` would mount, through OMP's own resolver.
 * @param runtime - host subprocess provider.
 * @param executable - resolved OMP executable.
 * @param cwd - existing directory whose project skills apply.
 * @returns visible and hidden skill rows in listing order.
 */
export async function listOmpSkills(
  runtime: SubprocessRuntime,
  executable: string,
  cwd: string,
): Promise<OmpSkillListing[]> {
  const handle = runtime.spawn({
    argv: [executable, 'skill', 'list', '--json'],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 256 * 1024 },
      stderr: { maxBytes: 64 * 1024 },
    },
    graceMs: 2_000,
    signal: AbortSignal.timeout(15_000),
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  if (outcome.exitCode !== 0) {
    throw new Error(`omp skill list failed (${String(outcome.exitCode ?? outcome.signal)}): ${stderr.trim().slice(-400)}`)
  }
  return parseOmpSkillListing(stdout)
}

/**
 * Skill directories in precedence order: the session working directory first,
 * then the per-account agent root, then the shared base world.
 */
const SKILL_ROOTS = [
  { base: 'cwd', path: '.omp/skills' },
  { base: 'cwd', path: '.agents/skills' },
  { base: 'home', path: '.omp/agent/skills' },
  { base: 'home', path: 'worlds/base/skills' },
] as const

/** OMP skill names are slug-shaped; anything else is a malformed SKILL.md. */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

/** Directories whose per-skill `SKILL.md` rows apply to one session. */
export interface OmpSkillRoots {
  /** Session working directory owning the project skill roots. */
  readonly cwd: string
  /** Account home owning the agent and base skill roots. */
  readonly home: string
}

/** Disk discovery plus the optional live listing, in precedence order. */
export interface OmpSkillResolution extends OmpSkillRoots {
  /** Live `omp skill list` lookup; a rejection falls back to disk discovery. */
  readonly list?: () => Promise<readonly OmpSkillListing[]>
}

/**
 * Read the YAML frontmatter block OMP uses for `SKILL.md`.
 * @param text - complete `SKILL.md` contents.
 * @returns parsed scalar fields; `undefined` when no frontmatter block opens.
 */
function skillFrontmatter(text: string): Record<string, string> | undefined {
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u)
  const start = lines.findIndex(line => line.trim() === '---')
  if (start < 0) return undefined
  const fields: Record<string, string> = {}
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '---') return fields
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    if (key.length === 0) continue
    let value = line.slice(separator + 1).trim()
    const quote = value[0]
    if (value.length > 1 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1)
    }
    fields[key] = value
  }
  return undefined
}

/**
 * Discover skills straight from `SKILL.md` frontmatter, without a subprocess.
 * @param roots - session working directory and account home to scan.
 * @returns visible skills in precedence order, first declaration winning.
 */
export async function discoverOmpSkillsFromDisk(roots: OmpSkillRoots): Promise<OmpSkillListing[]> {
  const skills: OmpSkillListing[] = []
  const seen = new Set<string>()
  for (const root of SKILL_ROOTS) {
    const directory = join(root.base === 'cwd' ? roots.cwd : roots.home, root.path)
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const text = await readFile(join(directory, entry.name, 'SKILL.md'), 'utf8').catch(() => undefined)
      if (text === undefined) continue
      const frontmatter = skillFrontmatter(text)
      if (frontmatter === undefined) continue
      const name = frontmatter.name ?? entry.name
      if (!SKILL_NAME.test(name) || seen.has(name)) continue
      seen.add(name)
      if (frontmatter.hide === 'true') continue
      skills.push({
        name,
        ...frontmatter.description === undefined ? {} : { description: frontmatter.description },
        source: root.path,
      })
    }
  }
  return skills
}

/**
 * Resolve the skills one session advertises, always include disk discovery.
 *
 * OMP's own resolver is authoritative when it answers, but a cold or slow
 * `omp skill list` must never empty the command palette, so a rejection falls
 * back to the `SKILL.md` rows already on disk. A live row that is hidden still
 * suppresses the same-named disk row.
 * @param options - session roots and the optional live listing lookup.
 * @returns visible skills in precedence order.
 */
export async function resolveOmpSkills(options: OmpSkillResolution): Promise<OmpSkillListing[]> {
  const [discovered, listed] = await Promise.all([
    discoverOmpSkillsFromDisk(options),
    options.list === undefined ? Promise.resolve([]) : options.list().catch(() => []),
  ])
  const seen = new Set<string>()
  const merged: OmpSkillListing[] = []
  for (const row of [...listed, ...discovered]) {
    if (seen.has(row.name)) continue
    seen.add(row.name)
    merged.push(row)
  }
  return merged.filter(skill => skill.hide !== true)
}

/**
 * Translate `/compact [args]` into the exact RPC frame OMP accepts.
 * @param rawInput - invocation text following `/compact`.
 * @returns the compact frame; `snapcompact` never carries focus instructions.
 */
export function ompCompactCommand(rawInput: string): OmpCompactCommand {
  const trimmed = rawInput.trim()
  if (trimmed.length === 0) return { type: 'compact' }
  const head = trimmed.split(/\s+/u)[0] ?? ''
  const rest = trimmed.slice(head.length).trim()
  if (head === 'snapcompact') {
    if (rest.length > 0) throw new Error('/compact snapcompact does not take focus instructions.')
    return { type: 'compact', mode: 'snapcompact' }
  }
  if (head === 'soft' || head === 'remote') {
    return { type: 'compact', mode: head, ...rest.length > 0 ? { customInstructions: rest } : {} }
  }
  return { type: 'compact', customInstructions: trimmed }
}
