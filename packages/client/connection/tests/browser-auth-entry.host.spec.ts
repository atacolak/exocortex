/** Browser document entry terminates independently of Strict-cookie redirect chains. */
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { BrowserAuth } from '../src/browser-auth.ts'
import type { ConnectionIndexRequest } from '../src/rpc.ts'
import { RecordCredentials } from './browser-credentials.ts'

const DOCUMENT = { accept: 'text/html,application/xhtml+xml', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
const MARKER = '__dsh_auth_continue'

async function createAuth(mesh = true): Promise<BrowserAuth> {
  vi.stubEnv('DSH_TRUST_MESH_CIDRS', mesh ? '127.0.0.0/8' : '')
  return BrowserAuth.create({}, new RecordCredentials() as unknown as CredentialProvider, 30)
}

function authorize(auth: BrowserAuth, url: string, headers: Record<string, string> = DOCUMENT, remoteAddress = '127.0.0.1') {
  const result = { allowed: false, status: 0, headers: {} as Readonly<Record<string, string>>, body: '' }
  const req: ConnectionIndexRequest = { method: 'GET', url, remoteAddress, headers: { host: 'localhost:3081', ...headers } }
  result.allowed = auth.authorizeIndex(req, {
    writeHead(status, values) { result.status = status; result.headers = values ?? {} },
    end(body) { result.body = body ?? '' },
  })
  return result
}

function navigationFrom(body: string, hash = ''): string {
  const scripts = [...body.matchAll(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/gu)]
  expect(scripts).toHaveLength(1)
  const navigations: string[] = []
  runInNewContext(scripts[0]![2]!, { location: { hash, replace: (value: string) => navigations.push(value) } }, { timeout: 100 })
  expect(navigations).toHaveLength(1)
  return navigations[0]!
}

afterEach(() => vi.unstubAllEnvs())

describe('first-party browser entry', () => {
  it('commits a document before continuing a cross-site mesh visit', async () => {
    const auth = await createAuth()
    const result = authorize(auth, '/?panel=actors', { ...DOCUMENT, 'sec-fetch-site': 'cross-site' })
    expect(result.allowed).toBe(false)
    expect(result.status).toBe(200)
    expect(result.headers['location']).toBeUndefined()
    expect(result.headers['set-cookie']).toContain('HttpOnly; SameSite=Strict')
    expect(navigationFrom(result.body)).toBe('./?panel=actors&__dsh_auth_continue=1')
  })

  it('recognizes HTML document entry on private HTTP without Fetch Metadata', async () => {
    const result = authorize(await createAuth(), '/', { accept: 'text/html;q=0.9,*/*;q=0.1' })
    expect(result.status).toBe(200)
    expect(navigationFrom(result.body)).toBe('./?__dsh_auth_continue=1')
  })

  it.each([
    { accept: '*/*' },
    { accept: 'application/json' },
    { accept: 'text/html;q=0,*/*;q=1' },
    { accept: 'text/html', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
    { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
    { accept: 'text/html', 'sec-fetch-mode': 'cors' },
  ])('retains the programmatic redirect for non-document request %j', async (headers) => {
    const result = authorize(await createAuth(), '/?panel=actors', headers)
    expect(result.status).toBe(303)
    expect(result.headers['location']).toBe('./?panel=actors')
    expect(result.headers['set-cookie']).toContain('SameSite=Strict')
  })

  it('stops rather than re-minting when the continuation has no cookie', async () => {
    const auth = await createAuth()
    const first = authorize(auth, '/?panel=actors')
    const target = new URL(navigationFrom(first.body), 'http://localhost:3081/')
    const next = authorize(auth, target.pathname + target.search)
    expect(next.allowed).toBe(false)
    expect(next.status).toBe(200)
    expect(next.headers['set-cookie']).toBeUndefined()
    expect(next.headers['location']).toBeUndefined()
    expect(next.body).toMatch(/cookies/iu)
    expect(next.body).not.toContain('<script')
  })

  it('cleans a verified continuation before serving the protected index', async () => {
    const auth = await createAuth()
    const first = authorize(auth, '/?panel=actors&tag=one&tag=two')
    const cookie = first.headers['set-cookie']!.split(';', 1)[0]!
    const next = authorize(auth, '/?panel=actors&tag=one&tag=two&__dsh_auth_continue=1', { ...DOCUMENT, cookie })
    expect(next.allowed).toBe(false)
    expect(next.status).toBe(303)
    expect(next.headers['location']).toBe('./?panel=actors&tag=one&tag=two')
    expect(next.headers['set-cookie']).toBeUndefined()
    expect(authorize(auth, '/?panel=actors&tag=one&tag=two', { ...DOCUMENT, cookie }).allowed).toBe(true)
  })

  it('does not treat repeated continuation markers as an authorization grant', async () => {
    const result = authorize(await createAuth(false), '/?__dsh_auth_continue=1&__dsh_auth_continue=2')
    expect(result.allowed).toBe(false)
    expect(result.status).toBe(200)
    expect(result.headers['set-cookie']).toBeUndefined()
    expect(result.body).not.toContain('<script')
  })

  it('removes tokens and pre-existing markers from the only continuation', async () => {
    const auth = await createAuth(false)
    const launch = new URL(auth.authenticatedUrl('http://localhost:3081/?panel=actors&__dsh_auth_continue=old'))
    const token = launch.searchParams.get('token')!
    const result = authorize(auth, launch.pathname + launch.search)
    expect(result.status).toBe(200)
    expect(result.body).not.toContain(token)
    const target = new URL(navigationFrom(result.body), 'http://localhost:3081/')
    expect([...target.searchParams.entries()]).toEqual([['panel', 'actors'], [MARKER, '1']])
  })

  it('keeps user-controlled queries inert under a nonce CSP and proxy mount', async () => {
    const auth = await createAuth()
    const query = new URLSearchParams({ panel: 'actors', returnTo: 'https://evil.invalid/', value: '</script><script>throw new Error("injected")</script>&"\'' })
    const result = authorize(auth, '/?' + query.toString())
    expect(result.status).toBe(200)
    const target = new URL(navigationFrom(result.body), 'https://gateway.example/tools/exocortex/')
    expect(target.origin).toBe('https://gateway.example')
    expect(target.pathname).toBe('/tools/exocortex/')
    expect(target.searchParams.get('value')).toBe(query.get('value'))
    expect(target.searchParams.get('returnTo')).toBe('https://evil.invalid/')
    expect(result.body).not.toContain('</script><script>')
    const nonce = /<script nonce="([^"]+)">/u.exec(result.body)![1]!
    expect(result.headers['content-security-policy']).toContain("script-src 'nonce-" + nonce + "'")
    expect(result.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(result.headers['content-security-policy']).toContain("base-uri 'none'")
    expect(result.headers['content-security-policy']).toContain("form-action 'self'")
    expect(result.headers['cache-control']).toBe('no-store')
    expect(result.headers['referrer-policy']).toBe('no-referrer')
    expect(result.headers['x-content-type-options']).toBe('nosniff')
    expect(result.headers['content-type']).toBe('text/html; charset=utf-8')
  })

  it('keeps desktop launch-token exchange at 303', async () => {
    const auth = await createAuth(false)
    const launch = new URL(auth.authenticatedUrl('http://localhost:3081/?panel=actors'))
    const result = authorize(auth, launch.pathname + launch.search, { accept: '*/*' })
    expect(result.status).toBe(303)
    expect(result.headers['set-cookie']).toContain('SameSite=Strict')
    expect(result.headers['location']).toBe('./?panel=actors')
  })

  it('uses the current document for manual navigation with only cleaned query fields', async () => {
    const auth = await createAuth(false)
    const launch = new URL(auth.authenticatedUrl('http://localhost:3081/?panel=actors&tag=one&tag=two&__dsh_auth_continue=old'))
    const result = authorize(auth, launch.pathname + launch.search)
    expect(result.body).toContain('<form method="get" accept-charset="UTF-8">')
    expect(result.body).not.toMatch(/<form[^>]*action=/u)
    expect(result.body).toContain('<input type="hidden" name="tag" value="one"><input type="hidden" name="tag" value="two">')
    expect(result.body).not.toContain('name="token"')
    expect(result.body.match(/name="__dsh_auth_continue"/gu)).toHaveLength(1)
    expect(result.body).toContain('name="__dsh_auth_continue" value="1"')
    expect(result.body).toContain('<button type="submit">Continue</button>')
    const retry = authorize(auth, '/?panel=actors&__dsh_auth_continue=1')
    expect(retry.body).not.toContain('name="__dsh_auth_continue"')
    expect(retry.body).toContain('<button type="submit">Try again</button>')
  })

  it('preserves the browser fragment across the first-party continuation', async () => {
    const result = authorize(await createAuth(), '/?panel=actors')
    expect(navigationFrom(result.body, '#selected-actor')).toBe('./?panel=actors&__dsh_auth_continue=1#selected-actor')
  })

})
