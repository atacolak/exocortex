import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, expect, it } from 'vitest'
import { ClientModuleRegistry } from '../src/index.ts'
import type { WebBootGraph } from '../src/client/manifest.ts'

const contexts: Context[] = []
const peer = { principal: { kind: 'owner' } } as Parameters<WebServer['collectIndexInjections']>[0]
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('loader', { entries: () => [] })
  await ctx.plugin(ClientModuleRegistry)
  return { ctx, registry: ctx.clientModules }
}
const selected = (graph: WebBootGraph): WebBootGraph => ({ ...graph, rev: 'selected', entries: [{ id: 'app', rev: 'overlay:chosen:one', url: '/selected.js', immediately: true }], batches: [{ phase: 'application', entries: ['app'], rev: 'overlay:chosen:one', url: '/selected.js' }] })

it('selects the first injection graph per document before exposing application preload URLs', async () => {
  const { ctx, registry } = await fixture()
  const normal = registry.graph()
  registry.registerBootSelector((graph, url) => url?.includes('exo_overlay=chosen') ? selected(graph) : graph)
  const rows: IndexInjection[] = []
  ctx.emit('webserver/index-inject', rows, peer, 'http://fixture/?s=owned&exo_overlay=chosen')
  expect(rows.find(row => row.kind === 'global' && row.name === '__DSH_BOOT__')).toEqual({ kind: 'global', name: '__DSH_BOOT__', value: selected(normal) })
  expect(rows.filter(row => row.kind === 'script-preload')).toEqual([{ kind: 'script-preload', src: '/selected.js' }])
  expect(registry.graph()).toBe(normal)
  expect(registry.bootGraph('http://fixture/?s=owned').entries).toEqual([])
})

it('propagates selection refusal before emitting any normal boot rows', async () => {
  const { ctx, registry } = await fixture()
  registry.registerBootSelector(() => { throw new Error('selected composition unavailable') })
  const rows: IndexInjection[] = []
  expect(() => { ctx.emit('webserver/index-inject', rows, peer, 'http://fixture/?exo_overlay=missing') }).toThrow('selected composition unavailable')
  expect(rows).toEqual([])
  expect(registry.graph().entries).toEqual([])
})

it('isolates selector mutation and rejects malformed output without changing shared state', async () => {
  const { registry } = await fixture()
  const normal = registry.graph()
  registry.registerBootSelector((graph) => { graph.entries.push({ id: 'private', rev: 'one', url: '/private.js' }); return { ...graph, rev: undefined } as unknown as WebBootGraph })
  expect(() => registry.bootGraph('http://fixture/')).toThrow()
  expect(normal.entries).toEqual([])
})

it('enforces one selector and prevents an old disposer removing a later registration of the same function', async () => {
  const { registry } = await fixture()
  const selector = (graph: WebBootGraph) => selected(graph)
  const off = registry.registerBootSelector(selector)
  expect(() => registry.registerBootSelector(selector)).toThrow('already registered')
  off()
  const second = registry.registerBootSelector(selector)
  off()
  expect(registry.bootGraph().rev).toBe('selected')
  second()
  expect(registry.bootGraph()).toBe(registry.graph())
})
