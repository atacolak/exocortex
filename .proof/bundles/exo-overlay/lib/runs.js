/** Overlay run layout, base-revision recording, and path safety for `/tmp/exo-overlay/<runId>/<pkg>/`. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { OverlayError } from './errors.js'

export const BASE_FILE = 'base.json'
export const STAGED_DIR = '.staged'

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/
const ARTIFACTS = ['client.js', 'index.js', 'package.json']
const HASHED = [['client', 'client.js'], ['index', 'index.js'], ['package', 'package.json']]

/** Reject a run id that could escape the overlay root or collide with a reserved name. */
export function assertRunId(runId) {
  if (typeof runId !== 'string' || !SEGMENT.test(runId) || runId === BASE_FILE) {
    throw new OverlayError(400, 'invalid-run-id', `overlay run id ${JSON.stringify(runId)} is not a single safe path segment`)
  }
  return runId
}

/** Reject a package name that is not a plain or scoped npm package name. */
export function assertPackageName(pkg) {
  if (typeof pkg !== 'string' || !PACKAGE_NAME.test(pkg)) {
    throw new OverlayError(400, 'invalid-package', `package ${JSON.stringify(pkg)} is not a plain or scoped package name`)
  }
  return pkg
}

/** Absolute run directory for one overlay run. */
export function runDirectory(root, runId) {
  return path.join(root, assertRunId(runId))
}

/** Absolute candidate directory for one package inside a run. */
export function candidateDirectory(root, runId, pkg) {
  return path.join(runDirectory(root, runId), assertPackageName(pkg))
}

/** Whether a directory holds candidate artifacts. */
function isCandidate(directory) {
  return ARTIFACTS.some(name => existsSync(path.join(directory, name)))
}

/**
 * List the packages staged in one run directory: direct children plus the
 * second level of `@scope` directories.
 * @param runDir - absolute run directory.
 * @returns sorted package names.
 */
export function listCandidatePackages(runDir) {
  if (!existsSync(runDir)) return []
  const found = []
  for (const name of readdirSync(runDir).sort()) {
    if (name.startsWith('.')) continue
    const directory = path.join(runDir, name)
    if (!statSync(directory).isDirectory()) continue
    if (name.startsWith('@')) {
      for (const child of readdirSync(directory).sort()) {
        const scoped = path.join(directory, child)
        if (statSync(scoped).isDirectory() && isCandidate(scoped)) found.push(`${name}/${child}`)
      }
      continue
    }
    if (isCandidate(directory)) found.push(name)
  }
  return found
}

/** Content hash of a canonical bundle's executable halves, or of its absence. */
export function canonicalBaseSha(bundlesRoot, pkg) {
  const directory = path.join(bundlesRoot, assertPackageName(pkg))
  const parts = []
  for (const [field, name] of HASHED) {
    const file = path.join(directory, name)
    parts.push(`${field}\0${existsSync(file) ? readFileSync(file, 'utf8') : ''}\0`)
  }
  return createHash('sha256').update(parts.join('')).digest('hex')
}

/** Read a run's recorded base revisions, or undefined when the run never recorded one. */
export function readBase(root, runId) {
  const file = path.join(runDirectory(root, runId), BASE_FILE)
  if (!existsSync(file)) return undefined
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new OverlayError(409, 'base-revision-unreadable', `overlay base record is not JSON: ${error.message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.packages !== 'object') {
    throw new OverlayError(409, 'base-revision-unreadable', 'overlay base record has no packages map')
  }
  return parsed
}

/**
 * Record the canonical base revision of every package the run stages. The
 * first recorded revision wins: a later stage of the same run never re-anchors
 * its CAS, so a stale candidate cannot promote over a newer canonical edit.
 * @returns the stored base record.
 */
export function recordBase({ root, bundlesRoot, runId, packages, hash = canonicalBaseSha, now = () => new Date().toISOString() }) {
  const directory = runDirectory(root, runId)
  mkdirSync(directory, { recursive: true })
  const existing = readBase(root, runId) ?? { runId, recordedAt: now(), packages: {} }
  const targets = packages === undefined ? listCandidatePackages(directory) : packages.map(assertPackageName)
  for (const pkg of targets) {
    if (existing.packages[pkg] === undefined) existing.packages[pkg] = hash(bundlesRoot, pkg)
  }
  const file = path.join(directory, BASE_FILE)
  const temporary = `${file}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(temporary, `${JSON.stringify(existing, null, 2)}\n`)
  renameSync(temporary, file)
  return existing
}

/** Remove one overlay run directory, leaving canonical bundles untouched. */
export function removeRun(root, runId) {
  const directory = runDirectory(root, runId)
  const existed = existsSync(directory)
  rmSync(directory, { recursive: true, force: true })
  return { removed: existed ? [directory] : [], directory }
}
