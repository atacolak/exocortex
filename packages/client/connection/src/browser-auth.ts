/** Browser-session authentication for the Host Connection carrier. */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { PeerId } from '@deepseek-ai/dsh-typert-protocol'
import { CONNECT_PATH, type ConnectionInteractions } from './connect-protocol.ts'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type {
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionTrustRequest,
} from './rpc.ts'

const AUTH_RECORD_KEY = credentialKey('client-connection', 'browser-session')
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const SECRET_BYTES = 32
const TOKEN_QUERY = 'token'
const CONTINUATION_QUERY = '__dsh_auth_continue'
const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_PAYLOAD_VERSION = 1
const STORED_SECRET_VERSION = 1
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/
const PROCESS_LAUNCH_TOKENS = new WeakMap<object, string>()
const MESH_TRUST_ENV = 'DSH_TRUST_MESH_CIDRS'
const IPV4_BITS = 32
const IPV4_MAPPED_PREFIX = '::ffff:'
const IPV4_OCTET_PATTERN = /^\d{1,3}$/u
const IPV4_PREFIX_PATTERN = /^\d{1,2}$/u

/** One trusted mesh subnet, held as the network address and its mask. */
interface Ipv4Cidr {
  readonly network: number
  readonly mask: number
}

function ipv4Number(text: string): number | undefined {
  const octets = text.split('.')
  if (octets.length !== 4) return undefined
  let value = 0
  for (const octet of octets) {
    if (!IPV4_OCTET_PATTERN.test(octet)) return undefined
    const byte = Number(octet)
    if (byte > 255) return undefined
    value = value * 256 + byte
  }
  return value
}

function parseMeshCidr(entry: string): Ipv4Cidr {
  const [address = '', prefix = '', ...rest] = entry.split('/')
  const network = ipv4Number(address)
  const bits = !IPV4_PREFIX_PATTERN.test(prefix) ? Number.NaN : Number(prefix)
  if (rest.length > 0 || network === undefined || !Number.isInteger(bits) || bits > IPV4_BITS) {
    throw new Error(`client-connection: ${MESH_TRUST_ENV} entry ${JSON.stringify(entry)} is not an IPv4 CIDR`)
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (IPV4_BITS - bits)) >>> 0
  return { network: (network & mask) >>> 0, mask }
}

/** Read `DSH_TRUST_MESH_CIDRS` as the trusted subnets; absent or empty means no mesh trust. */
function parseMeshCidrs(raw: string | undefined): readonly Ipv4Cidr[] {
  if (raw === undefined) return []
  const cidrs: Ipv4Cidr[] = []
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    cidrs.push(parseMeshCidr(trimmed))
  }
  return cidrs
}

interface StoredSecretPayload {
  readonly version: typeof STORED_SECRET_VERSION
  readonly secret: string
}

interface BrowserCookiePayload {
  readonly version: typeof COOKIE_PAYLOAD_VERSION
  readonly authority: string
  readonly issuedAt: number
  readonly expiresAt: number
}

interface ApiCookiePayload extends Omit<BrowserCookiePayload, 'version'> {
  readonly version: 2
  readonly id: PeerId
}

type CookiePayload = BrowserCookiePayload | ApiCookiePayload

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

function processLaunchToken(owner: object): string {
  const existing = PROCESS_LAUNCH_TOKENS.get(owner)
  if (existing !== undefined) return existing
  const created = encodeBase64Url(randomBytes(SECRET_BYTES))
  PROCESS_LAUNCH_TOKENS.set(owner, created)
  return created
}

function header(
  headers: ConnectionTrustRequest['headers'],
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Render the same-directory target without launch tokens or browser-entry bookkeeping. */
function cleanRedirectTarget(url: URL): string {
  const kept = new URLSearchParams()
  for (const [key, value] of url.searchParams) {
    if (key !== TOKEN_QUERY && key !== CONTINUATION_QUERY) kept.append(key, value)
  }
  const query = kept.toString()
  return query.length === 0 ? './' : `./?${query}`
}

/** Select a document response without widening the token or mesh authorization grant. */
function isBrowserDocument(req: ConnectionIndexRequest): boolean {
  const destination = header(req.headers, 'sec-fetch-dest')
  const mode = header(req.headers, 'sec-fetch-mode')
  const site = header(req.headers, 'sec-fetch-site')
  if (destination !== undefined || mode !== undefined || site !== undefined) {
    return destination === 'document' && mode === 'navigate'
  }
  // Plain HTTP browsers may omit Fetch Metadata; Desktop's Node fetch accepts */*.
  return header(req.headers, 'accept')?.split(',').some((entry) => {
    const [media, ...parameters] = entry.toLowerCase().split(';')
    if (media?.trim() !== 'text/html') return false
    const quality = parameters.find(parameter => /^\s*q\s*=/u.test(parameter))
    if (quality === undefined) return true
    const value = Number(quality.slice(quality.indexOf('=') + 1).trim())
    return value > 0 && value <= 1
  }) ?? false
}

/** Escape query names and values for the landing's manual continuation form. */
function htmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Protocol-scoped cookie audience; HTTP retains its existing authority-only spelling. */
function requestAudience(headers: ConnectionTrustRequest['headers'], secure: boolean): string | undefined {
  const host = header(headers, 'host')
  if (host === undefined) return undefined
  try {
    const url = new URL(`${secure ? 'https:' : 'http:'}//${host}`)
    return secure ? url.origin : url.host
  } catch {
    return undefined
  }
}

function canonicalSecret(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined
  const decoded = decodeBase64Url(value)
  if (decoded === undefined || decoded.byteLength !== SECRET_BYTES) return undefined
  return decoded
}

function storedSecret(record: CredentialRecord | undefined): Buffer | undefined {
  if (record === undefined) return undefined
  if (record.kind !== 'grant' || !isRecord(record.payload)
    || record.payload.version !== STORED_SECRET_VERSION) {
    throw new Error('client-connection: browser-session credential record has an unsupported format')
  }
  const secret = canonicalSecret(record.payload.secret)
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record has an invalid secret')
  }
  return secret
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes)
}

function cookieName(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/** Read the exact generated cookie without implementing general Cookie decoding. */
function cookieValue(headerValue: string, name: string): string | undefined {
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/** Serialize the fixed browser-session attributes; generated names and values are cookie-safe base64url. */
function sessionCookie(
  name: string,
  value: string,
  expiresAt: number,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const attributes = `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`
  return secure ? `${attributes}; Secure` : attributes
}

function signature(secret: Buffer, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest()
}

function encodeCookie(payload: CookiePayload, secret: Buffer): string {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `v${payload.version}.${body}.${encodeBase64Url(signature(secret, body))}`
}

function decodeCookie(value: string, secret: Buffer): CookiePayload | undefined {
  const parts = value.split('.')
  const [version, body, encodedSignature] = parts
  if (parts.length !== 3 || (version !== 'v1' && version !== 'v2') || body === undefined || encodedSignature === undefined) {
    return undefined
  }
  const actualSignature = decodeBase64Url(encodedSignature)
  if (actualSignature === undefined) return undefined
  const expectedSignature = signature(secret, body)
  if (actualSignature.byteLength !== expectedSignature.byteLength
    || !timingSafeEqual(actualSignature, expectedSignature)) return undefined
  let decoded: unknown
  try {
    const bodyBytes = decodeBase64Url(body)
    if (bodyBytes === undefined) return undefined
    decoded = JSON.parse(bodyBytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(decoded)
    || (decoded.version !== COOKIE_PAYLOAD_VERSION && decoded.version !== 2)
    || version !== `v${decoded.version}`
    || typeof decoded.authority !== 'string'
    || typeof decoded.issuedAt !== 'number' || !Number.isSafeInteger(decoded.issuedAt)
    || typeof decoded.expiresAt !== 'number' || !Number.isSafeInteger(decoded.expiresAt)) return undefined
  const payload = { authority: decoded.authority, issuedAt: decoded.issuedAt, expiresAt: decoded.expiresAt }
  if (decoded.version === COOKIE_PAYLOAD_VERSION) return { version: COOKIE_PAYLOAD_VERSION, ...payload }
  if (typeof decoded.id !== 'string' || decoded.id.length === 0) return undefined
  return { version: 2, ...payload, id: decoded.id as PeerId }
}

async function initializeSecret(credentials: CredentialProvider): Promise<Buffer> {
  const generated: StoredSecretPayload = {
    version: STORED_SECRET_VERSION,
    secret: encodeBase64Url(randomBytes(SECRET_BYTES)),
  }
  const record = await credentials.modifyRecord(AUTH_RECORD_KEY, (current) => {
    if (current !== undefined) {
      storedSecret(current)
      return Promise.resolve(undefined)
    }
    return Promise.resolve({ kind: 'grant', payload: generated })
  })
  const secret = storedSecret(record)
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record was not created')
  }
  return secret
}

/**
 * Process launch-token exchange and persistent signed-cookie verification.
 * Connection loads the credential provider's signing secret during activation
 * and retains it for synchronous request authentication.
 */
export class BrowserAuth {
  private readonly launchToken: string
  private readonly maxAgeMilliseconds: number

  private constructor(
    processOwner: object,
    private readonly secret: Buffer,
    maxAgeDays: number,
    private readonly meshCidrs: readonly Ipv4Cidr[],
  ) {
    this.launchToken = processLaunchToken(processOwner)
    this.maxAgeMilliseconds = maxAgeDays * DAY_MILLISECONDS
    if (!Number.isSafeInteger(this.maxAgeMilliseconds)
      || !Number.isSafeInteger(Date.now() + this.maxAgeMilliseconds)) {
      throw new Error('client-connection: cookieMaxAgeDays exceeds the safe timestamp range')
    }
  }

  /**
   * Initialize browser authentication and create its durable signing secret
   * when this Harness home has none.
   * @param processOwner - root application context retaining one token across Connection reloads.
   * @param credentials - persistent credential provider for the Web profile.
   * @param maxAgeDays - positive absolute browser-cookie lifetime in days.
   * @returns initialized authentication owner with the process owner's launch token.
   */
  static async create(
    processOwner: object,
    credentials: CredentialProvider,
    maxAgeDays: number,
  ): Promise<BrowserAuth> {
    return new BrowserAuth(
      processOwner,
      await initializeSecret(credentials),
      maxAgeDays,
      parseMeshCidrs(process.env[MESH_TRUST_ENV]),
    )
  }

  /**
   * Add this process's launch token to the caller's application URL.
   * @param baseUrl - clean browser URL whose authority and mount are preserved.
   * @returns the same URL carrying the process token as its sole authentication input.
   */
  authenticatedUrl(baseUrl: string): string {
    const url = new URL(baseUrl)
    url.searchParams.set(TOKEN_QUERY, this.launchToken)
    return url.href
  }

  /**
   * Authenticate an index request. A valid root token or trusted-mesh root
   * visit mints the signed cookie. Browser documents receive a first-party
   * landing with one continuation; programmatic clients retain the 303 exchange.
   * The continuation requires the cookie and removes its bookkeeping query.
   * Missing cookies stop at an explanation instead of another automatic mint.
   * A valid cookie lets the caller serve the index; other requests receive 401.
   * @param req - incoming root or configured-index request.
   * @param res - response owned when this method returns false.
   * @param secure - whether the listener receiving this request serves TLS; the
   * minted cookie carries `Secure` when it does. Only that listener's own
   * protocol decides, never a `publicUrl` announcement or a forwarded header:
   * those describe a hop this process does not terminate.
   * @returns true only when the caller may serve index.html.
   */
  authorizeIndex(req: ConnectionIndexRequest, res: ConnectionIndexResponse, secure = false): boolean {
    /* v8 ignore next -- node:http always supplies url on server requests. */
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const tokens = url.searchParams.getAll(TOKEN_QUERY)
    if (tokens.length > 0) {
      const authority = requestAudience(req.headers, secure)
      if (req.method === 'GET' && url.pathname === '/' && tokens.length === 1
        && authority !== undefined && tokenMatches(tokens.join(''), this.launchToken)) {
        this.writeSessionEntry(req, res, url, secure)
        return false
      }
      if (req.method === 'GET' && url.pathname === '/' && this.isAuthenticated(req, secure)) {
        this.writeCleanRedirect(res, url)
        return false
      }
    } else if (this.isAuthenticated(req, secure)) {
      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has(CONTINUATION_QUERY)) {
        this.writeCleanRedirect(res, url)
        return false
      }
      return true
    }
    if (tokens.length === 0 && req.method === 'GET' && url.pathname === '/'
      && url.searchParams.has(CONTINUATION_QUERY)) {
      if (isBrowserDocument(req)) this.writeBrowserLanding(res, url)
      else this.writeUnauthorized(req, res)
      return false
    }
    if (this.trustsMeshIndex(req, url)) {
      this.writeSessionEntry(req, res, url, secure)
      return false
    }
    this.writeUnauthorized(req, res)
    return false
  }

  /**
   * Whether an unauthenticated root request arrives from a configured mesh subnet.
   * @param req - incoming index request.
   * @param url - the request target, already parsed against the placeholder origin.
   * @returns true only for a `GET /` whose socket address falls inside one trusted CIDR.
   */
  private trustsMeshIndex(req: ConnectionIndexRequest, url: URL): boolean {
    if (this.meshCidrs.length === 0) return false
    if (req.method !== 'GET' || url.pathname !== '/') return false
    const remote = req.remoteAddress
    const address = remote === undefined
      ? undefined
      : ipv4Number(remote.startsWith(IPV4_MAPPED_PREFIX) ? remote.slice(IPV4_MAPPED_PREFIX.length) : remote)
    return address !== undefined && this.meshCidrs.some(cidr => ((address & cidr.mask) >>> 0) === cidr.network)
  }

  private writeSessionEntry(
    req: ConnectionIndexRequest,
    res: ConnectionIndexResponse,
    url: URL,
    secure: boolean,
  ): void {
    const authority = requestAudience(req.headers, secure)
    if (authority === undefined) {
      this.writeUnauthorized(req, res)
      return
    }
    const issuedAt = Date.now()
    const expiresAt = issuedAt + this.maxAgeMilliseconds
    const value = encodeCookie({
      version: COOKIE_PAYLOAD_VERSION,
      authority,
      issuedAt,
      expiresAt,
    }, this.secret)
    const cookie = sessionCookie(
      cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1000), secure,
    )
    if (isBrowserDocument(req)) {
      this.writeBrowserLanding(res, url, cookie)
      return
    }
    res.writeHead(303, {
      'cache-control': 'no-store',
      'location': cleanRedirectTarget(url),
      'referrer-policy': 'no-referrer',
      'set-cookie': cookie,
    })
    res.end()
  }

  /** A newly minted cookie permits one navigation; an absent continuation cookie stops here. */
  private writeBrowserLanding(res: ConnectionIndexResponse, url: URL, cookie?: string): void {
    const clean = cleanRedirectTarget(url)
    const target = cookie === undefined
      ? clean
      : `${clean}${clean.includes('?') ? '&' : '?'}${CONTINUATION_QUERY}=1`
    const nonce = cookie === undefined ? undefined : randomBytes(16).toString('base64')
    const headers: Record<string, string> = {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        + (nonce === undefined ? '' : `; script-src 'nonce-${nonce}'`),
    }
    if (cookie !== undefined) headers['set-cookie'] = cookie
    const title = cookie === undefined ? 'Cookies are required' : 'Opening the application'
    const message = cookie === undefined
      ? 'This browser did not return the sign-in cookie. Allow cookies for this site, then reopen the original link. Automatic retry has stopped.'
      : 'Establishing a private browser session. If this page does not continue, use the button below.'
    const label = cookie === undefined ? 'Try again' : 'Continue'
    const inputs = [...new URL(target, 'http://browser-entry.invalid/').searchParams]
      .map(([name, value]) => `<input type="hidden" name="${htmlAttribute(name)}" value="${htmlAttribute(value)}">`).join('')
    const script = nonce === undefined
      ? ''
      : `<script nonce="${nonce}">location.replace(${JSON.stringify(target).replaceAll('<', '\\u003c')} + location.hash)</script>`
    res.writeHead(200, headers)
    res.end('<!doctype html><html lang="en"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + `<title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p>`
      + `<form method="get" accept-charset="UTF-8">${inputs}<button type="submit">${label}</button></form></main>${script}</body></html>`)
  }

  private writeCleanRedirect(res: ConnectionIndexResponse, url: URL): void {
    res.writeHead(303, {
      'cache-control': 'no-store',
      'location': cleanRedirectTarget(url),
      'referrer-policy': 'no-referrer',
    })
    res.end()
  }

  /**
   * Exchange the launch token for an independent API operator; omitted interactions default to none.
   * @param req - trusted GET request on /connect with at most one interactions declaration.
   * @param res - response owned to completion, redirecting to the API mux on success.
   * @param secure - whether the receiving listener serves TLS.
   * @param publish - synchronously create the operator before exposing its signed credential.
   */
  authorizeConnect(
    req: ConnectionIndexRequest,
    res: ConnectionIndexResponse,
    secure: boolean,
    publish: (interactions: ConnectionInteractions) => PeerId,
  ): void {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const declarations = url.searchParams.getAll('interactions')
    const interactions = declarations[0] ?? 'none'
    if (declarations.length > 1 || (interactions !== 'answer' && interactions !== 'none')) {
      res.writeHead(400, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
      res.end('interactions must be declared once as answer or none\n')
      return
    }
    const tokens = url.searchParams.getAll(TOKEN_QUERY)
    const authority = requestAudience(req.headers, secure)
    if (req.method !== 'GET' || url.pathname !== CONNECT_PATH || tokens.length !== 1
      || authority === undefined || !tokenMatches(tokens.join(''), this.launchToken)) {
      this.writeUnauthorized(req, res)
      return
    }
    const issuedAt = Date.now()
    const expiresAt = issuedAt + this.maxAgeMilliseconds
    const id = publish(interactions)
    const value = encodeCookie({ version: 2, authority, id, issuedAt, expiresAt }, this.secret)
    res.writeHead(302, {
      'cache-control': 'no-store',
      'location': './api/remote.mux',
      'referrer-policy': 'no-referrer',
      'set-cookie': sessionCookie(
        cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1000), secure,
      ),
    })
    res.end()
  }

  /**
   * Verify the authority-bound browser cookie on a Host request.
   * @param request - request headers carrying Host and Cookie.
   * @param secure - whether the receiving listener uses TLS, including its default port.
   * @returns true only for an unexpired cookie signed by this activation's loaded secret.
   */
  isAuthenticated(request: ConnectionTrustRequest, secure = false): boolean {
    return this.authenticate(request, secure)?.version === COOKIE_PAYLOAD_VERSION
  }

  /**
   * Verify an API credential without creating or reviving its operator.
   * @param request - request headers carrying Host and Cookie.
   * @param secure - whether the receiving listener uses TLS.
   * @returns the signed operator id, or undefined for invalid, expired, or browser cookies.
   */
  authenticateApi(request: ConnectionTrustRequest, secure = false): PeerId | undefined {
    const payload = this.authenticate(request, secure)
    return payload?.version === 2 ? payload.id : undefined
  }

  private authenticate(request: ConnectionTrustRequest, secure: boolean): CookiePayload | undefined {
    const authority = requestAudience(request.headers, secure)
    const rawCookie = header(request.headers, 'cookie')
    if (authority === undefined || rawCookie === undefined) return undefined
    const value = cookieValue(rawCookie, cookieName(authority))
    if (value === undefined) return undefined
    const payload = decodeCookie(value, this.secret)
    if (payload === undefined || payload.authority !== authority) return undefined
    const now = Date.now()
    if (payload.issuedAt > now || payload.expiresAt <= now || payload.expiresAt <= payload.issuedAt
      || payload.expiresAt - payload.issuedAt > this.maxAgeMilliseconds) return undefined
    return payload
  }

  private writeUnauthorized(req: ConnectionIndexRequest, res: ConnectionIndexResponse): void {
    res.writeHead(401, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    })
    res.end(req.method === 'HEAD'
      ? undefined
      : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
  }
}
