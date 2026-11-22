/**
 * `?exo_overlay` sandbox host half: candidate delivery under
 * `/api/exocortex/overlay/<runId>/<pkg>/`, the transactional promote that
 * rebuilds canonical bundles through `hmr-runner`, and one bounded live probe
 * per promote. The client half (./client.js) is inert until the document URL
 * carries `?exo_overlay=<runId>`.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
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
        () => ctx.clientModules.registerBootSelector((graph, documentUrl) => selectOverlayBoot(graph, documentUrl, resolved.overlayRoot)),
        'exocortex-exo-overlay: initial document composition',
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
