/**
 * Transactional promote for `?exo_overlay` runs: base-revision CAS, off-path
 * build, one synchronous rename batch with rollback, then one rebuild notice
 * per package. A failed promote writes no canonical file.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { OverlayError } from './errors.js'
import { overlayRows } from './contract.js'
import {
  STAGED_DIR, candidateDirectory, canonicalBaseSha, readBase, removeRun, runDirectory,
} from './runs.js'

const SKIP_DIRS = new Set(['node_modules', '.git', STAGED_DIR, '.exo-overlay-backup'])
const CLIENT_MARKER = '__ModuleLoader__.load('
const HOST_EXPORT = /\bexport\s*(\{|\*|default\b|const\b|function\b|class\b)/
const BACKUP_DIR = '.exo-overlay-backup'

/** Serialize every promote and discard through one promise chain. */
function createMutex() {
  let tail = Promise.resolve()
  return (task) => {
    const run = tail.then(task, task)
    tail = run.then(() => undefined, () => undefined)
    return run
  }
}

/** Copy one candidate tree into the staging directory, skipping run bookkeeping. */
function copyTree(source, target) {
  mkdirSync(target, { recursive: true })
  for (const name of readdirSync(source).sort()) {
    if (SKIP_DIRS.has(name) || name.startsWith('.staged')) continue
    const from = path.join(source, name)
    const to = path.join(target, name)
    if (statSync(from).isDirectory()) copyTree(from, to)
    else if (statSync(from).isFile()) {
      mkdirSync(path.dirname(to), { recursive: true })
      copyFileSync(from, to)
    }
  }
}

/** List a staged tree's files as sorted relative paths. */
function walkFiles(directory, base = directory, found = []) {
  for (const name of readdirSync(directory).sort()) {
    const absolute = path.join(directory, name)
    if (statSync(absolute).isDirectory()) walkFiles(absolute, base, found)
    else if (statSync(absolute).isFile()) found.push(path.relative(base, absolute))
  }
  return found
}

/** The module identity a canonical bundle declares, or undefined when it declares none. */
function canonicalModuleIdentity(directory) {
  const file = path.join(directory, 'package.json')
  if (!existsSync(file)) return undefined
  try {
    const declared = JSON.parse(readFileSync(file, 'utf8'))?.name
    return typeof declared === 'string' && declared !== '' ? declared : undefined
  } catch {
    return undefined
  }
}

/** Reject a candidate whose module identity is not the one its canonical storage key serves. */
function inspectCandidate(directory, row, canonicalDirectory) {
  const canonical = canonicalModuleIdentity(canonicalDirectory)
  if (canonical === undefined || canonical === row.id) return
  throw new OverlayError(422, 'candidate-package-mismatch', `candidate ${row.pkg} declares module identity ${row.id}, but canonical ${row.pkg} serves ${canonical}`, {
    wroteCanonical: false,
    packages: [{ id: row.id, pkg: row.pkg, declared: canonical }],
  })
}

/** Validate the artifacts a build left in the staging directory. */
function validateArtifacts(directory, id) {
  const errors = []
  const clientFile = path.join(directory, 'client.js')
  const hostFile = path.join(directory, 'index.js')
  if (existsSync(clientFile)) {
    const text = readFileSync(clientFile, 'utf8')
    if (!text.includes(CLIENT_MARKER)) errors.push(`client.js does not call ${CLIENT_MARKER}`)
    if (!text.includes(id)) errors.push(`client.js does not register ${id}`)
  }
  if (existsSync(hostFile)) {
    const text = readFileSync(hostFile, 'utf8')
    if (text.trim() === '') errors.push('index.js is empty')
    else if (!HOST_EXPORT.test(text)) errors.push('index.js carries no ESM export')
  }
  if (!existsSync(clientFile) && !existsSync(hostFile)) errors.push('candidate has neither client.js nor index.js')
  return errors
}

/** Content hash used when the host exposes no rebuilt revision for a host-only package. */
function artifactRev(bundlesRoot, pkg) {
  for (const name of ['client.js', 'index.js']) {
    const file = path.join(bundlesRoot, pkg, name)
    if (existsSync(file)) return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
  }
  return 'unbuilt'
}

/** Undo the swaps completed so far, newest first. */
function rollback(swaps) {
  let complete = true
  for (const swap of [...swaps].reverse()) {
    try {
      if (swap.existed) {
        rmSync(swap.target, { force: true })
        renameSync(swap.backup, swap.target)
      } else {
        rmSync(swap.target, { force: true })
      }
    } catch {
      complete = false
    }
  }
  return complete
}

/** Drop one transaction's staged and backup trees. */
function cleanup(stagedRoot, backupRoot) {
  rmSync(stagedRoot, { recursive: true, force: true })
  rmSync(backupRoot, { recursive: true, force: true })
  for (const parent of [path.dirname(stagedRoot), path.dirname(backupRoot)]) {
    try {
      if (existsSync(parent) && readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true })
    } catch {
      // A concurrent promote owns the shared parent directory while it runs.
    }
  }
}

/**
 * Build the promote and discard operations over one overlay root.
 * @param options - `root`, `bundlesRoot`, injected `build(stagedDir, pkg)`, and `rebuilt(id)`.
 * @returns serialized `promote` and `discard` operations.
 */
export function createPromoter({ root, bundlesRoot, build, rebuilt = () => undefined, now = () => new Date().toISOString(), transactionId = () => `${Date.now()}-${process.pid}` }) {
  if (typeof build !== 'function') throw new TypeError('createPromoter requires a build(stagedDir, pkg) function')
  const serialize = createMutex()

  const promote = ({ runId }) => serialize(async () => {
    const runDir = runDirectory(root, runId)
    if (!existsSync(runDir)) throw new OverlayError(404, 'overlay-run-missing', `overlay run ${runId} is not staged`)
    const targets = overlayRows(root, runId)
    if (targets.length === 0) throw new OverlayError(404, 'overlay-run-empty', `overlay run ${runId} stages no package`)
    const base = readBase(root, runId)
    if (base === undefined) {
      throw new OverlayError(409, 'base-revision-unrecorded', `overlay run ${runId} never recorded a base revision; render it once in ?exo_overlay=${runId} before promoting`, { wroteCanonical: false })
    }
    const unrecorded = targets.filter(row => base.packages[row.pkg] === undefined)
    if (unrecorded.length > 0) {
      throw new OverlayError(409, 'base-revision-unrecorded', `overlay run ${runId} has no base revision for ${unrecorded.map(row => row.pkg).join(', ')}`, {
        wroteCanonical: false, packages: unrecorded.map(row => ({ id: row.id, pkg: row.pkg })),
      })
    }

    const drift = []
    for (const row of targets) {
      const actual = canonicalBaseSha(bundlesRoot, row.pkg)
      if (actual !== base.packages[row.pkg]) drift.push({ id: row.id, pkg: row.pkg, expected: base.packages[row.pkg], actual })
    }
    if (drift.length > 0) {
      throw new OverlayError(409, 'base-revision-drift', 'canonical bundle changed since this run recorded its base', {
        wroteCanonical: false, packages: drift,
      })
    }

    const id = transactionId()
    const stagedRoot = path.join(runDir, STAGED_DIR, id)
    const backupRoot = path.join(bundlesRoot, BACKUP_DIR, id)
    const failures = []
    try {
      for (const row of targets) {
        const candidate = candidateDirectory(root, runId, row.pkg)
        inspectCandidate(candidate, row, path.join(bundlesRoot, row.pkg))
        const staged = path.join(stagedRoot, row.pkg)
        copyTree(candidate, staged)
        let result
        try {
          result = await build(staged, row.pkg)
        } catch (error) {
          result = { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
        }
        if (result?.ok === false) {
          failures.push({ id: row.id, pkg: row.pkg, errors: Array.isArray(result.errors) ? result.errors.map(String) : ['build failed'] })
          continue
        }
        const errors = validateArtifacts(staged, row.id)
        if (errors.length > 0) failures.push({ id: row.id, pkg: row.pkg, errors })
      }
      if (failures.length > 0) {
        throw new OverlayError(422, 'build-failed', 'candidate build failed; canonical bundles were not written', {
          wroteCanonical: false, packages: failures,
        })
      }

      const swaps = []
      try {
        for (const row of targets) {
          const staged = path.join(stagedRoot, row.pkg)
          for (const relative of walkFiles(staged)) {
            const target = path.join(bundlesRoot, row.pkg, relative)
            const backup = path.join(backupRoot, row.pkg, relative)
            mkdirSync(path.dirname(target), { recursive: true })
            mkdirSync(path.dirname(backup), { recursive: true })
            const existed = existsSync(target)
            if (existed) renameSync(target, backup)
            try {
              renameSync(path.join(staged, relative), target)
            } catch (error) {
              if (existed) renameSync(backup, target)
              throw error
            }
            swaps.push({ target, backup, existed })
          }
        }
      } catch (error) {
        const complete = rollback(swaps)
        throw new OverlayError(500, 'promote-write-failed', `canonical write failed: ${error instanceof Error ? error.message : String(error)}`, {
          wroteCanonical: false, rolledBack: complete, packages: targets.map(row => ({ id: row.id, pkg: row.pkg })),
        })
      }

      const packages = targets.map((row) => {
        let rev
        try {
          rev = rebuilt(row.id)
        } catch (error) {
          rev = undefined
          void error
        }
        return { id: row.id, pkg: row.pkg, rev: typeof rev === 'string' && rev !== '' ? rev : artifactRev(bundlesRoot, row.pkg) }
      })
      cleanup(stagedRoot, backupRoot)
      removeRun(root, runId)
      return { runId, packages, removedRunDirectory: true, promotedAt: now() }
    } catch (error) {
      cleanup(stagedRoot, backupRoot)
      throw error
    }
  })

  const discard = ({ runId }) => serialize(async () => {
    const removed = removeRun(root, runId)
    return { runId, removed: removed.removed, discardedAt: now() }
  })

  return { promote, discard }
}

export { validateArtifacts, inspectCandidate }
