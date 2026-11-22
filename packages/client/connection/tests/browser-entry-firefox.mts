/** Disposable Firefox proof of the actual host browser-auth entry. No live profile or actors. */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { RecordCredentials } from './browser-credentials.ts'
import { isTrustedApiRequest } from '../src/api-request-trust.ts'

const requireWeb = createRequire(new URL('../../../../apps/web/package.json', import.meta.url))
const { firefox } = requireWeb('playwright')
const sourcePath = resolve(process.env.AUTH_BROWSER_SOURCE ?? new URL('../src/browser-auth.ts', import.meta.url).pathname)
const { BrowserAuth } = await import(pathToFileURL(sourcePath).href)
const proofDir = resolve(process.env.AUTH_PROOF_DIR ?? '.proof/browser-auth-entry/firefox')
await mkdir(proofDir, { recursive: true })
process.env.DSH_TRUST_MESH_CIDRS = '127.0.0.0/8'
const auth = await BrowserAuth.create({}, new RecordCredentials() as unknown as CredentialProvider, 30)
const record: { startedAt: string, sourceSha256: string, checks: unknown[], complete: boolean } = {
  startedAt: new Date().toISOString(),
  sourceSha256: createHash('sha256').update(await readFile(sourcePath)).digest('hex'),
  checks: [], complete: false,
}
const observations: { path: string, continuation: boolean, cookieSent: boolean, status: number }[] = []
let indexServed = 0
const server = createServer((req, res) => {
  const incoming = new URL(req.url ?? '/', 'http://fixture.invalid')
  const mounted = incoming.pathname === '/tools/exocortex/'
  const request = {
    method: req.method, url: mounted ? '/' + incoming.search : req.url,
    headers: req.headers, remoteAddress: req.socket.remoteAddress,
  }
  if (incoming.pathname === '/api/probe') {
    const trusted = isTrustedApiRequest(request, [], '127.0.0.1')
    res.writeHead(!trusted ? 403 : auth.isAuthenticated(request) ? 200 : 401, { 'content-type': 'application/json' })
    res.end('{"fixture":true}')
    return
  }
  if (incoming.pathname !== '/' && !mounted) { res.writeHead(404); res.end(); return }
  const observation = {
    path: incoming.pathname, continuation: incoming.searchParams.has('__dsh_auth_continue'),
    cookieSent: typeof req.headers.cookie === 'string' && req.headers.cookie.includes('dsh-auth-'),
    status: 0,
  }
  observations.push(observation)
  res.once('finish', () => { observation.status = res.statusCode })
  if (auth.authorizeIndex(request, res)) {
    indexServed++
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end('<!doctype html><title>Authenticated fixture</title><h1>Authenticated test index</h1>')
  }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
assert(address !== null && typeof address === 'object')
const origin = 'http://127.0.0.1:' + address.port
async function save() { await writeFile(resolve(proofDir, 'receipt.json'), JSON.stringify(record, null, 2) + '\n') }
await save()
const browsers: any[] = []
async function browser(disableCookies = false) {
  const instance = await firefox.launch({
    headless: true,
    ...(process.env.FIREFOX_EXECUTABLE ? { executablePath: process.env.FIREFOX_EXECUTABLE } : {}),
    ...(disableCookies ? { firefoxUserPrefs: { 'network.cookie.cookieBehavior': 2 } } : {}),
  })
  browsers.push(instance)
  return instance
}
try {
  const fx = await browser()
  for (const test of [
    { name: 'direct-root', path: '/?panel=actors', crossSite: false },
    { name: 'cross-site-root', path: '/?panel=actors', crossSite: true },
    { name: 'cross-site-fragment', path: '/?panel=actors#selected-actor', crossSite: true },
    { name: 'cross-site-mounted-query', path: '/tools/exocortex/?panel=actors&value=%3C%2Fscript%3E%3Cscript%3Ethrow%201%3C%2Fscript%3E&returnTo=https%3A%2F%2Fevil.invalid%2F', crossSite: true },
  ]) {
    const context = await fx.newContext()
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error: Error) => errors.push(error.name))
    const start = observations.length
    const target = origin + test.path
    if (test.crossSite) {
      await page.goto('data:text/html,' + encodeURIComponent('<a href="' + target.replaceAll('&', '&amp;') + '">Open fixture</a>'))
      await page.getByRole('link', { name: 'Open fixture' }).click({ timeout: 10000 })
    } else await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 10000 })
    await page.getByRole('heading', { name: 'Authenticated test index' }).waitFor({ timeout: 10000 })
    const final = new URL(page.url())
    assert.equal(final.origin, origin)
    assert.equal(final.pathname, new URL(target).pathname)
    assert.equal(final.hash, new URL(target).hash)
    assert.equal(final.searchParams.get('panel'), 'actors')
    assert.equal(final.searchParams.has('token'), false)
    assert.equal(final.searchParams.has('__dsh_auth_continue'), false)
    assert.deepEqual(errors, [])
    const chain = observations.slice(start)
    assert(chain.length <= 3, 'document entry exceeded one landing plus cleanup')
    const cookies = await context.cookies()
    assert(cookies.some((value: any) => value.name.startsWith('dsh-auth-') && value.sameSite === 'Strict' && value.httpOnly))
    const api = await page.evaluate(async () => (await fetch('/api/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status)
    assert.equal(api, 200)
    record.checks.push({ name: test.name, ok: true, chain, cookie: { sameSite: 'Strict', httpOnly: true }, apiStatus: api })
    await save()
    await context.close()
  }

  const manualContext = await fx.newContext({ javaScriptEnabled: false })
  const manualPage = await manualContext.newPage()
  const manualLaunch = auth.authenticatedUrl(origin + '/tools/exocortex/?panel=actors&tag=one&tag=two&__dsh_auth_continue=old#selected-actor')
  await manualPage.goto(manualLaunch, { waitUntil: 'domcontentloaded' })
  await manualPage.getByRole('button', { name: 'Continue', exact: true }).click()
  await manualPage.getByRole('heading', { name: 'Authenticated test index' }).waitFor()
  const manualFinal = new URL(manualPage.url())
  assert.equal(manualFinal.origin, origin)
  assert.equal(manualFinal.pathname, '/tools/exocortex/')
  assert.equal(manualFinal.search, '?panel=actors&tag=one&tag=two')
  assert.equal(manualFinal.hash, '#selected-actor')
  record.checks.push({ name: 'javascript-disabled-manual-continue', ok: true, proxyPathPreserved: true, duplicateQueryPreserved: true, fragmentPreserved: true, tokenAndMarkerRemoved: true })
  await save()
  await manualContext.close()

  const disabled = await browser(true)
  const context = await disabled.newContext()
  const page = await context.newPage()
  const start = observations.length
  const before = indexServed
  await page.goto('data:text/html,' + encodeURIComponent('<a href="' + origin + '/?panel=actors">Open fixture</a>'))
  await page.getByRole('link', { name: 'Open fixture' }).click({ timeout: 10000 })
  await page.getByRole('heading', { name: 'Cookies are required' }).waitFor({ timeout: 10000 })
  assert.equal(await page.locator('script').count(), 0)
  assert.equal(indexServed, before)
  const disabledChain = observations.slice(start)
  assert.equal(disabledChain.length, 2)
  assert.equal((await context.cookies()).length, 0)
  await page.screenshot({ path: resolve(proofDir, 'cookies-disabled.png'), fullPage: true })
  record.checks.push({ name: 'cookies-disabled-bounded', ok: true, chain: disabledChain, protectedIndexServed: false })
  await save()
  await context.close()

  const exchange = await fetch(origin + '/', { redirect: 'manual' })
  assert.equal(exchange.status, 303)
  const cookie = exchange.headers.get('set-cookie')!.split(';', 1)[0]!
  await exchange.body?.cancel()
  for (const rejection of [
    { name: 'foreign-origin', headers: { origin: 'https://evil.invalid' } },
    { name: 'opaque-origin', headers: { origin: 'null' } },
    { name: 'cross-site-metadata', headers: { 'sec-fetch-site': 'cross-site' } },
    { name: 'untrusted-host', headers: { host: 'evil.invalid' } },
  ]) {
    // Node fetch normalizes Host; raw node:http preserves the rebinding test input.
    const status = await new Promise<number>((done, fail) => {
      const request = httpRequest(origin + '/api/probe', { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...rejection.headers } }, (response) => {
        response.resume()
        response.once('end', () => done(response.statusCode ?? 0))
      })
      request.once('error', fail)
      request.end('{}')
    })
    assert.equal(status, 403)
    record.checks.push({ name: rejection.name, ok: true, status: 403 })
  }
  record.checks.push({ name: 'programmatic-exchange', ok: true, status: 303, cookiePolicy: 'Strict' })
  record.complete = true
  await save()
  process.stdout.write(JSON.stringify({ ok: true, checks: record.checks.length, receipt: resolve(proofDir, 'receipt.json') }) + '\n')
} catch (error) {
  record.checks.push({ name: 'failure', ok: false, observedDocuments: observations, type: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message.replace(/https?:\/\/[^\s]+/gu, '[fixture-url]') : 'unknown' })
  await save()
  process.exitCode = 1
  process.stdout.write(JSON.stringify({ ok: false, receipt: resolve(proofDir, 'receipt.json') }) + '\n')
} finally {
  for (const instance of browsers) await instance.close()
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
}
