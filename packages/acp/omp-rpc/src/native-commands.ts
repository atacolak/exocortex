import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

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
