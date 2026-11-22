import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { selectOverlayBoot } from '../bundles/exo-overlay/lib/boot.js'

const graph = {
  rev: 'canonical',
  entries: [{ id: '@fixture/ui', url: 'plugins/canonical.js', rev: 'base' }],
  batches: [{ phase: 'application', url: 'plugins/canonical.js', rev: 'base', entries: ['@fixture/ui'] }],
}

test('missing overlay offers an explicit same-directory recovery without creating state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'exo-entry-missing-'))
  try {
    let failure
    try { selectOverlayBoot(graph, 'https://host.invalid/tools/exo/?exo_overlay=fable-panes&panel=actors&chat=session-123&tag=a&tag=b&token=fixture-secret', root) }
    catch (error) { failure = error }
    assert(failure instanceof Response)
    assert.equal(failure.status, 404)
    assert.equal(failure.headers.get('location'), null)
    assert.equal(failure.headers.get('cache-control'), 'no-store')
    const body = await failure.text()
    assert.match(body, /Open current workspace/u)
    assert.match(body, /fable-panes/u)
    assert.doesNotMatch(body, /<script|http-equiv="refresh"|fixture-secret/u)
    const href = /href="([^"]+)"/u.exec(body)?.[1]?.replaceAll('&amp;', '&')
    assert.equal(href, './?panel=actors&chat=session-123&tag=a&tag=b')
    const returnUrl = new URL(href, 'https://host.invalid/tools/exo/')
    assert.equal(returnUrl.origin, 'https://host.invalid')
    assert.equal(returnUrl.pathname, '/tools/exo/')
    assert.deepEqual(await readdir(root), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('retained query values cannot inject HTML or override the recovery origin', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'exo-entry-escaping-'))
  try {
    const params = new URLSearchParams({ exo_overlay: 'missing', panel: '</a><script>throw 1</script>', chat: '" onfocus="alert(1)', returnTo: 'https://evil.invalid/' })
    let failure
    try { selectOverlayBoot(graph, 'https://host.invalid/?' + params.toString(), root) }
    catch (error) { failure = error }
    assert(failure instanceof Response)
    const body = await failure.text()
    assert.doesNotMatch(body, /<script>| onfocus=/u)
    const href = /href="([^"]+)"/u.exec(body)[1].replaceAll('&amp;', '&')
    const target = new URL(href, 'https://host.invalid/')
    assert.equal(target.origin, 'https://host.invalid')
    assert.equal(target.searchParams.get('panel'), params.get('panel'))
    assert.equal(target.searchParams.get('chat'), params.get('chat'))
    assert.equal(target.searchParams.get('returnTo'), 'https://evil.invalid/')
    assert.equal(target.searchParams.has('exo_overlay'), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('valid overlays still select their original candidate and invalid names still reject', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'exo-entry-valid-'))
  try {
    const directory = path.join(root, 'valid', '@fixture', 'ui')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: '@fixture/ui' }))
    await writeFile(path.join(directory, 'client.js'), 'fixture')
    const selected = selectOverlayBoot(graph, 'https://host.invalid/?exo_overlay=valid', root)
    assert.match(selected.entries[0].url, /\/valid\/@fixture\/ui\/client.js/u)
    assert.match(selected.entries[0].rev, /^overlay:valid:/u)
    assert.equal(graph.entries[0].url, 'plugins/canonical.js')
    assert.equal(selectOverlayBoot(graph, 'https://host.invalid/?panel=actors', root), graph)
    assert.throws(() => selectOverlayBoot(graph, 'https://host.invalid/?exo_overlay=..%2Fescape', root), { code: 'invalid-run-id' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
