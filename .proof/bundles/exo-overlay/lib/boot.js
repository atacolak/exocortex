import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { overlayRows } from './contract.js'
import { OverlayError } from './errors.js'
import { missingOverlayResponse } from './entry-recovery.js'
import { assertRunId, candidateDirectory } from './runs.js'

/** Resolve this document's initial composition without changing the canonical graph. */
export function selectOverlayBoot(graph, documentUrl, root) {
  if (documentUrl === undefined) return graph
  const url = new URL(documentUrl)
  if (!url.searchParams.has('exo_overlay')) return graph
  const values = url.searchParams.getAll('exo_overlay')
  if (values.length !== 1 || !values[0]) throw new OverlayError(400, 'invalid-run-id', 'Choose one non-empty overlay name or return to the normal URL')
  const runId = assertRunId(values[0])
  const rows = overlayRows(root, runId)
  if (rows.length === 0) throw missingOverlayResponse(url, runId)
  const canonical = new Set(graph.entries.map(row => row.id))
  const bootstrap = graph.batches.filter(batch => batch.phase === 'bootstrap')
  const bootstrapIds = new Set(bootstrap.flatMap(batch => batch.entries))
  const replacements = new Map()
  for (const row of rows) {
    if (!canonical.has(row.id) || bootstrapIds.has(row.id)) throw new OverlayError(422, 'overlay-module-unavailable', 'Selected overlay cannot replace module ' + row.id)
    if (!existsSync(path.join(candidateDirectory(root, runId, row.pkg), 'client.js'))) throw new OverlayError(422, 'candidate-client-missing', 'Selected overlay has no client for ' + row.id)
    replacements.set(row.id, row)
  }
  const entries = graph.entries.map(row => {
    const selected = replacements.get(row.id)
    return selected === undefined ? row : { ...row, url: selected.url, rev: selected.rev }
  })
  // Canonical combo batches may contain replaced factories. Never preload them:
  // all application registrations use the exact URL/revision pair of their row.
  const applications = new Map()
  for (const row of entries) {
    if (bootstrapIds.has(row.id)) continue
    const batch = applications.get(row.url)
    if (batch) batch.entries.push(row.id)
    else applications.set(row.url, { phase: 'application', url: row.url, rev: row.rev, entries: [row.id] })
  }
  const batches = [...bootstrap, ...applications.values()]
  const rev = createHash('sha256').update(JSON.stringify({ canonical: graph.rev, entries, batches })).digest('hex').slice(0, 12)
  return { ...graph, rev, entries, batches }
}
