/**
 * Wire contract shared by the overlay host routes and the candidate rows the
 * client rewrites. A candidate carries two identities that are never the same
 * value: `id` is the module identity (the package name the boot graph keys a
 * row by) and `pkg` is the storage key (the directory the run stages, which is
 * also the artifact URL path segment).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { OverlayError } from './errors.js'
import { assertPackageName, candidateDirectory, listCandidatePackages, runDirectory } from './runs.js'

export const ROUTE_PREFIX = '/api/exocortex/overlay'
export const EVENTS_ROUTE = `${ROUTE_PREFIX}/events`

/** A candidate's content revision: the hash of its client half, else its host half. */
export function candidateSha(root, runId, pkg) {
  for (const name of ['client.js', 'index.js']) {
    const file = path.join(candidateDirectory(root, runId, pkg), name)
    if (existsSync(file)) return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
  }
  return undefined
}

/** The revision an overlaid graph row must carry; `entries.sync` compares rev and ignores url alone. */
export function overlayRevision(runId, sha) {
  return `overlay:${runId}:${sha}`
}

/** The revisioned one-resource URL of a candidate; `pkg` is the storage key, never the module identity. */
export function overlayUrl(runId, pkg, rev) {
  return `${ROUTE_PREFIX}/${runId}/${pkg}/client.js?rev=${encodeURIComponent(rev)}`
}

/** The module identity a staged candidate declares: its package name, never its directory. */
export function candidateModuleIdentity(root, runId, pkg) {
  const file = path.join(candidateDirectory(root, runId, pkg), 'package.json')
  if (!existsSync(file)) {
    throw new OverlayError(422, 'candidate-identity-unknown', `candidate ${pkg} has no package.json, so the graph row it substitutes is unknown`)
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new OverlayError(422, 'candidate-identity-unknown', `candidate ${pkg} package.json is not JSON: ${error.message}`)
  }
  const declared = manifest?.name
  if (typeof declared !== 'string' || declared === '') {
    throw new OverlayError(422, 'candidate-identity-unknown', `candidate ${pkg} declares no package name, so the graph row it substitutes is unknown`)
  }
  try {
    return assertPackageName(declared)
  } catch {
    throw new OverlayError(422, 'candidate-identity-unknown', `candidate ${pkg} declares ${JSON.stringify(declared)}, which is not a package name`)
  }
}

/** One manifest row for a staged candidate. */
export function overlayRow(root, runId, pkg) {
  const id = candidateModuleIdentity(root, runId, pkg)
  const sha = candidateSha(root, runId, pkg)
  if (sha === undefined) throw new OverlayError(404, 'candidate-missing', `candidate for ${pkg} has no client.js or index.js`)
  const rev = overlayRevision(runId, sha)
  return { id, pkg, rev, url: overlayUrl(runId, pkg, rev) }
}

/** Every manifest row one run stages; two candidates may not claim one module identity. */
export function overlayRows(root, runId) {
  const rows = listCandidatePackages(runDirectory(root, runId)).map(pkg => overlayRow(root, runId, pkg))
  const owners = new Map()
  for (const row of rows) {
    const owner = owners.get(row.id)
    if (owner !== undefined) {
      throw new OverlayError(422, 'candidate-identity-duplicate', `candidates ${owner} and ${row.pkg} both claim module identity ${row.id}, so neither can substitute a graph row`)
    }
    owners.set(row.id, row.pkg)
  }
  return rows
}
