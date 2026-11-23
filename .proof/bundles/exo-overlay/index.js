/**
 * `?exo_overlay` sandbox host half: candidate delivery under
 * `/api/exocortex/overlay/<runId>/<pkg>/`, the transactional promote that
 * rebuilds canonical bundles through `hmr-runner`, and one bounded live probe
 * per promote. The client half (./client.js) is inert until the document URL
 * carries `?exo_overlay=<runId>`.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, cpSync, rmSync, lstatSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPromoter } from './lib/promote.js'
import { createOverlayRoutes, ROUTE_PREFIX } from './lib/routes.js'
import { createVerifier } from './lib/verify.js'
import { selectOverlayBoot } from './lib/boot.js'

export const name = 'exocortex-exo-overlay'
export const inject = ['webServer', 'clientModules']
export { ROUTE_PREFIX }

const BUNDLE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))

// Only the named workbench is persistent. All other overlay run IDs remain
// disposable development candidates rooted under the existing /tmp directory.
export function prepareWorkbenchLink(temporaryRoot, persistentWorkbenchDirectory) {
  if (persistentWorkbenchDirectory === undefined) return
  const saved = absolutePath(persistentWorkbenchDirectory, 'persistentWorkbenchDirectory')
  const candidate = path.join(temporaryRoot, 'workbench')
  if (!existsSync(path.join(saved, '@exocortex', 'exo-workbench', 'client.js'))) {
    throw new Error('persistent workbench is missing its built client; refusing an empty view')
  }
  mkdirSync(temporaryRoot, { recursive: true })
  let present
  try { present = lstatSync(candidate) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (present?.isSymbolicLink()) {
    if (realpathSync(candidate) !== realpathSync(saved)) throw new Error('workbench points to an unexpected location')
    rmSync(candidate)
    present = undefined
  }
  if (present && !present.isDirectory()) throw new Error('workbench path is not a directory')
  if (!present) cpSync(saved, candidate, { recursive: true })
  if (!existsSync(path.join(candidate, '@exocortex', 'exo-workbench', 'client.js'))) throw new Error('workbench staged client is missing')
}

// A workspace choice changes the *initial document*, not an already running
// main graph. The cookie is a non-secret UI preference; authorization remains
// with Connection on the next request.
export function preferredWorkspaceResponse(request) {
  let status, headers
  const handled = preferredWorkspaceRedirect({
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers),
  }, {
    writeHead(nextStatus, nextHeaders) { status = nextStatus; headers = nextHeaders },
    end() {},
  })
  return handled ? new Response(null, {status, headers}) : undefined
}

export function preferredWorkspaceRedirect(request, response) {
  if (!['GET', 'HEAD'].includes(request?.method || 'GET')) return false
  const url = new URL(typeof request?.url === 'string' ? request.url : '/', 'http://localhost')
  if (url.pathname !== '/' && url.pathname !== '/index.html') return false
  const overlay = url.searchParams.getAll('exo_overlay')
  let chosen
  if (overlay.length === 1 && overlay[0] === 'fable-panes') chosen = 'workbench'
  else if (overlay.length === 1 && overlay[0] === 'main') chosen = 'main'
  else if (overlay.length === 0) {
    const raw = String(request.headers?.cookie || '')
    chosen = /(?:^|;\s*)exo_last_view=workbench(?:;|$)/.test(raw) ? 'workbench' : undefined
  }
  if (chosen === undefined) return false
  if (chosen === 'main') url.searchParams.delete('exo_overlay')
  else url.searchParams.set('exo_overlay', chosen)
  const target = url.pathname + url.search + url.hash
  const headers = { Location: target, 'Cache-Control': 'no-store', Vary: 'Cookie' }
  if (overlay.length === 1 && ['main','fable-panes'].includes(overlay[0])) {
    const secure = String(request.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
    headers['Set-Cookie'] = 'exo_last_view=' + chosen + '; Path=/; SameSite=Lax; Max-Age=31536000' + (secure ? '; Secure' : '')
  }
  response.writeHead(302, headers)
  response.end()
  return true
}

function absolutePath(value, field) {
  if (typeof value !== 'string' || value === '' || !path.isAbsolute(value)) {
    throw new Error(`exocortex-exo-overlay: ${field} must be an absolute path`)
  }
  return value
}

function positiveInteger(value, field, fallback) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`exocortex-exo-overlay: ${field} must be a positive integer`)
  }
  return value
}

/**
 * Resolve the overlay root, the canonical bundles root, and the build runner.
 * @param config - plugin config; every field is optional.
 * @param environment - env fallbacks and the bundle directory (for tests).
 * @returns the validated runtime paths and flush bounds.
 */
export function resolveConfig(config = {}, { env = process.env, bundleDirectory = BUNDLE_DIRECTORY } = {}) {
  const overlayRoot = config.overlayRoot ?? env.EXOCORTEX_OVERLAY_ROOT ?? path.join(os.tmpdir(), 'exo-overlay')
  const bundlesRoot = config.bundlesRoot ?? env.EXOCORTEX_BUNDLES_ROOT ?? path.resolve(bundleDirectory, '..')
  const buildRunner = config.buildRunner ?? env.EXOCORTEX_BUILD_RUNNER ?? path.join(bundlesRoot, 'hmr-runner', 'build-bundles.mjs')
  return {
    overlayRoot: absolutePath(overlayRoot, 'overlayRoot'),
    bundlesRoot: absolutePath(bundlesRoot, 'bundlesRoot'),
    buildRunner: absolutePath(buildRunner, 'buildRunner'),
    bun: typeof config.bun === 'string' && config.bun !== '' ? config.bun : env.BUN_BIN ?? 'bun',
    persistentWorkbenchDirectory: config.persistentWorkbenchDirectory === undefined ? undefined : absolutePath(config.persistentWorkbenchDirectory, 'persistentWorkbenchDirectory'),
    pollIntervalMs: positiveInteger(config.pollIntervalMs, 'pollIntervalMs', 250),
    buildTimeoutMs: positiveInteger(config.buildTimeoutMs, 'buildTimeoutMs', 120_000),
  }
}

function linesOf(text) {
  return String(text).split('\n').map(line => line.trim()).filter(line => line !== '')
}

/**
 * Run the hmr-runner build over one staged candidate directory.
 * @returns `{ ok, errors }`; a start failure is a build failure, never a throw.
 */
export function runBuild({ bun, buildRunner, buildTimeoutMs }, stagedDirectory) {
  return new Promise((resolve) => {
    let settled = false
    let timer
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const child = spawn(bun, [buildRunner, stagedDirectory], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.on('error', error => finish({ ok: false, errors: [`build runner failed to start: ${error.message}`] }))
    child.on('close', (code, signal) => {
      if (code === 0) {
        finish({ ok: true })
        return
      }
      const errors = linesOf(stderr).slice(-8)
      finish({
        ok: false,
        errors: errors.length > 0 ? errors : [`build runner exited ${code === null ? signal : code}`],
      })
    })
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, errors: [`build runner exceeded ${buildTimeoutMs}ms`] })
    }, buildTimeoutMs)
    timer.unref?.()
  })
}

function bundleBuild(resolved) {
  return async (stagedDirectory) => {
    if (!existsSync(path.join(stagedDirectory, 'src'))) return { ok: true, skipped: true }
    return runBuild(resolved, stagedDirectory)
  }
}

/**
 * Build the overlay plugin with injectable build and probe seams.
 * @param options - build, probe, clock, and id injection.
 * @returns a Cordis plugin object `{ name, inject, apply }`.
 */
export function createOverlayPlugin({ build, probe, now, createId } = {}) {
  return {
    name,
    inject,
    apply(ctx, config = {}) {
      const resolved = resolveConfig(config)
      prepareWorkbenchLink(resolved.overlayRoot, resolved.persistentWorkbenchDirectory)
      const promoter = createPromoter({
        root: resolved.overlayRoot,
        bundlesRoot: resolved.bundlesRoot,
        build: build ?? bundleBuild(resolved),
        rebuilt: id => ctx.clientModules.rebuilt(id),
        ...(now === undefined ? {} : { now }),
      })
      const verifier = createVerifier({
        ...(probe === undefined ? {} : { probe }),
        ...(now === undefined ? {} : { now }),
        ...(createId === undefined ? {} : { createId }),
      })
      const routes = createOverlayRoutes({
        root: resolved.overlayRoot,
        bundlesRoot: resolved.bundlesRoot,
        promoter,
        verifier,
        pollIntervalMs: resolved.pollIntervalMs,
        ...(now === undefined ? {} : { now }),
      })
      ctx.effect(
        () => ctx.clientModules.registerBootSelector((graph, documentUrl) => {
          prepareWorkbenchLink(resolved.overlayRoot, resolved.persistentWorkbenchDirectory)
          return selectOverlayBoot(graph, documentUrl, resolved.overlayRoot, true)
        }),
        'exocortex-exo-overlay: initial document composition',
      )
      ctx.effect(
        () => ctx.on('webserver/index-route', request => preferredWorkspaceResponse(request)),
        'exocortex-exo-overlay: pre-document workspace selection',
      )
      ctx.effect(
        () => ctx.on('connection/request', (request, response, next) => routes.handle(request, response, next)),
        'exocortex-exo-overlay: /api/exocortex/overlay routes',
      )
    },
  }
}

export function apply(ctx, config = {}) {
  return createOverlayPlugin({}).apply(ctx, config)
}
