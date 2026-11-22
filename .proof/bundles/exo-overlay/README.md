# @exocortex/exo-overlay

The `?exo_overlay=<runId>` sandbox from Phase 2 P2-1: a manager stages candidate
bundle artifacts into `/tmp/exo-overlay/<runId>/<pkg>/`, points one tab at
`/?s=<session>&exo_overlay=<runId>`, and promotes only what the operator has
actually seen working.

## Host half (`index.js`)

`inject: ['webServer', 'clientModules']`, mounted through `cordis.patch.yml`.

| route | behavior |
| --- | --- |
| `GET /api/exocortex/overlay/<runId>/<pkg>/client.js?rev=<hash>` | serves the candidate artifact with `cache-control: no-store`; `<pkg>` is the storage key, not the module id; records the canonical base revision on first read |
| `GET /api/exocortex/overlay/<runId>/manifest` | the staged rows the client rewrites its graph with: `{ id, pkg, rev, url }` |
| `GET /api/exocortex/overlay/<runId>/events` | candidate SSE: `overlay`, `refreshed`, `removed`, `failed` frames pushed by a recursive `fs.watch` on the run directory, with a bounded stat poll as the fallback |
| `POST /api/exocortex/overlay/<runId>/promote` | the transactional promote; returns 200 with the rebuilt revisions, or 409/422 with `details.wroteCanonical === false` |
| `POST /api/exocortex/overlay/<runId>/discard` | removes the run directory, zero canonical writes |
| `GET /api/exocortex/overlay/verifications?package=<pkg>` | the bounded post-promote probe records, newest first |

The promote is four steps, in this order:

1. **CAS** - every staged package's canonical executable hash must still equal
   the base recorded when the run first served a candidate; drift answers
   `409 base-revision-drift` before anything is written.
2. **Off-path build** - every package is copied into
   `/tmp/exo-overlay/<runId>/.staged/<tx>/<pkg>` and built and validated there.
   One failing package aborts the whole promote with `422 build-failed` and
   **zero** canonical writes.
3. **Synchronous rename batch** - one `renameSync` loop swaps the staged files
   into `/home/sf/worlds/exocortex-bundles/<pkg>/`, keeping a rollback backup;
   any throw restores every completed swap.
4. **One rebuild notice per package** - `ctx.clientModules.rebuilt(id)` for all
   N packages in the same tick, then the run directory is removed.

### Identity

A staged candidate carries two identities that are never interchangeable:

| field | meaning | example |
| --- | --- | --- |
| `id` | module identity: the canonical scoped package name, the key of `__DSH_BOOT__.entries[]` | `@exocortex/tool-views` |
| `pkg` | storage key: the flat directory under `/tmp/exo-overlay/<runId>/` and the first URL path segment | `tool-views` |
| `rev` | overlay revision | `overlay:<runId>:<sha>` |
| `url` | fully resolved artifact URL, carried explicitly so no consumer reconstructs it | `/api/exocortex/overlay/<runId>/tool-views/client.js?rev=...` |

The identity comes from the candidate's own `package.json` `name`; a candidate
without one fails with `422 candidate-identity-unknown` naming the directory.
Two candidates that resolve to the same module identity fail with
`422 candidate-identity-duplicate`. A promoted candidate is validated against
the canonical package's own `package.json` `name`, and its promoted directory
is the storage key, so a scoped package in a flat directory promotes cleanly.

Verification never blocks the promote reply: one probe runs at a time, records
are capped, and a full queue is reported as `status: 'skipped'` on the record.

### What the probe checks

`POST .../promote` accepts an optional `markers: string[]` body field — the
distinctive strings the candidate introduced (for example the text the change
adds to its client module). The probe reads the live page's
`globalThis["__DSH_BOOT__"]` graph, and for every promoted package:

- requires a graph row whose `rev` equals the promoted revision (a host still
  serving the old revision records `failed`, not `verified`);
- fetches the module URL that row publishes and requires a `2xx`;
- requires every supplied marker inside the served source.

A passing delivery check records `status: 'partial'`: the host process cannot
render the page, so the record's `reason` says the DOM was not audited instead
of presenting the module check as a surface pass. A missing marker, an old
revision, or a module that answers non-`2xx` records `status: 'failed'` with
the exact reason. Without markers the probe still checks delivery and records
`partial` with that limitation.

`GET /api/exocortex/overlay/verifications?package=<pkg>` lists the records,
newest first.

## Client half (`client.js`)

`inject: ['modules']`, loaded immediately, **inert** unless
`location.search` carries a safe `?exo_overlay=<runId>`:

- fetches the manifest, matches rows to graph entries **by module identity**,
  and rewrites **only** the overlaid rows' `url` and `rev` (`rev` is what
  `entries.sync` compares; a `url`-only change is a silent no-op), then syncs
  once. A row without `pkg` or `rev`, or an id no graph entry serves, is an
  explicit failure, never a guessed path or a silent no-op.
- wraps `ctx.modules.entries.sync` / `.reload` so a global HMR graph frame does
  not resync the canonical row over the candidate, and canonical
  `reload(id, canonicalRev)` for an overlaid id is ignored while other ids
  still reload.
- follows candidate SSE `refreshed` frames into an in-place
  `entries.reload(id, overlayRev)` using the frame's own `url`, and surfaces
  `entries.state.failures` plus host frames in a banner so a broken candidate's
  error stays inside the overlay tab.
- the banner reports requested vs matched candidates, every matched
  `id@rev`, and every unmatched id; `rows.size` alone is not activation.

Host correction activation and client HMR stay separate: a promoted host half
needs a host reload, while the client half is swapped by the existing canonical
HMR path.

Entering and exiting the sandbox is a **fresh document load**: `[Open Full Tab]`
uses `window.open(url, '_blank', 'noopener')` and `[Exit Sandbox]` uses
`location.assign('/?s=<session>')`. There is no `pushState`/`replaceState` path:
candidates share the page's `window` realm, so a candidate cannot be safely
torn out of a live realm, and the operator's main tab must stay untouched as a
lifeboat.

## Configuration

| field | default |
| --- | --- |
| `overlayRoot` | `$EXOCORTEX_OVERLAY_ROOT` or `/tmp/exo-overlay` |
| `bundlesRoot` | `$EXOCORTEX_BUNDLES_ROOT` or the parent of this bundle |
| `buildRunner` | `$EXOCORTEX_BUILD_RUNNER` or `<bundlesRoot>/hmr-runner/build-bundles.mjs` |
| `bun` | `$BUN_BIN` or `bun` |
| `pollIntervalMs` | `250` (candidate SSE stat poll fallback behind the run-directory watcher) |
| `buildTimeoutMs` | `120000` |

## Tests

```sh
node --test test/*.test.mjs
```

`test/promote.test.mjs` owns the two required P2-1 transactions: a 2-package
promote where package B fails leaves package A untouched, and two overlays from
the same base where the second gets `409` without overwriting the first.
