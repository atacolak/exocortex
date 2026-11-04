import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as ompRpc from '../src/index.ts'

async function mountedPlugin(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  ctx.provide('tools', { definitions: () => [] } as never)
  ctx.provide('subprocess', {} as never)
  await ctx.plugin(ompRpc, { bindingsFile: '/tmp/omp-rpc-commands-spec/bindings.json', watchRunDir: false })
  return ctx
}

async function scopedAgent(ctx: Context, id: string): Promise<Agent> {
  const session = Session.create(SessionId(id))
  const agent = { id: session.id, session, model: { current: () => undefined } } as unknown as Agent & { ctx: Context }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  return agent
}

describe('OMP slash palette', () => {
  it('publishes no harness companion command under the omp prefix', async () => {
    const ctx = await mountedPlugin()
    const agent = await scopedAgent(ctx, 'session-omp-palette')
    const names = ctx.commands.list(agent).map(command => command.name)
    expect(names.filter(name => name.startsWith('omp'))).toEqual([])
  })
})
