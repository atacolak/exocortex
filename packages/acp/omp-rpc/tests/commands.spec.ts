import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as ompRpc from '../src/index.ts'

interface MountOptions {
  readonly cwd?: string
  readonly home?: string
}

async function mountedPlugin(options: MountOptions = {}): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  ctx.provide('tools', { definitions: () => [] } as never)
  ctx.provide('subprocess', { resolveExecutable: async (command: string) => command } as never)
  ctx.provide('llm', { registerAdapter: () => () => {} } as never)
  ctx.provide('agents', { setFactory: () => {} } as never)
  ctx.provide('sessionProjections', {
    register: async () => ({ readerFor: () => undefined }),
  } as never)
  await ctx.plugin(ompRpc, {
    bindingsFile: '/tmp/omp-rpc-commands-spec/bindings.json',
    watchRunDir: false,
    ...options,
  })
  return ctx
}

async function scopedAgent(ctx: Context, id: string): Promise<Agent> {
  const session = Session.create(SessionId(id))
  const agent = { id: session.id, session, model: { current: () => undefined } } as unknown as Agent & { ctx: Context }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  return agent
}

async function skillDirectory(root: string, name: string, description: string): Promise<void> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`, 'utf8')
}

describe('OMP slash palette', () => {
  it('publishes no harness companion command under the omp prefix', async () => {
    const ctx = await mountedPlugin()
    const agent = await scopedAgent(ctx, 'session-omp-palette')
    const names = ctx.commands.list(agent).map(command => command.name)
    expect(names.filter(name => name.startsWith('omp'))).toEqual([])
  })

  it('registers skill:* commands for symlinked skill directories once discovery resolves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omp-skill-palette-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const home = join(root, 'home')
    const cwd = join(root, 'project')
    const shared = join(home, 'worlds/base/skills')
    await mkdir(cwd, { recursive: true })
    await skillDirectory(shared, 'cordis-plugin-development', 'Use for Cordis plugins')
    await skillDirectory(shared, 'agent-experience', 'Use for tool definitions')
    const linked = join(home, '.omp/agent/skills')
    await mkdir(linked, { recursive: true })
    await symlink(join(shared, 'cordis-plugin-development'), join(linked, 'cordis-plugin-development'), 'dir')
    await symlink(join(shared, 'agent-experience'), join(linked, 'agent-experience'), 'dir')

    const ctx = await mountedPlugin({ cwd, home })
    const changes: string[] = []
    ctx.on('commands/change', () => { changes.push('change') })
    const agent = await scopedAgent(ctx, 'session-omp-skills')

    ctx.emit('agent/created', { agent, source: 'startup' })
    await vi.waitFor(() => {
      expect(ctx.commands.list(agent).map(command => command.name))
        .toContain('skill:cordis-plugin-development')
    })

    const names = ctx.commands.list(agent).map(command => command.name)
    expect(names).toContain('skill:agent-experience')
    expect(names).toContain('compact')
    expect(changes.length).toBeGreaterThan(0)

    const skill = ctx.commands.find(agent, 'skill:cordis-plugin-development')
    expect(skill?.description).toBe('Use for Cordis plugins')
    expect(skill?.input).toEqual({ hint: 'arguments' })
  })
})
