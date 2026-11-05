# AGENTS.md — Exocortex

Exocortex is an interactive human–agent co-working environment. It is **not** upstream DeepSeek Harness.
The authority is `/home/sf/workspace/deepseek-harness/CHARTER.md`; where this file disagrees, the CHARTER wins.

## 1. What this system is

Three parts, each owning one thing:

- **OMP (`oh-my-pi`) is the brain.** It owns sessions (`.jsonl` + `history.db` `session_episodes`),
  `<agent>.md` capabilities, subagent execution, and persistent daemon sockets
  (`~/.omp/run/<sessionId>.sock`). DSH never runs a competing agent loop.
- **HCOM + `actor` own identity.** Persistent actor identity, lifecycle, and cross-actor messaging
  (`send_to_actor`). Not a task queue.
- **Cordis is the body.** Composable Web UI and dynamic capability surface. `@exocortex/*` bundles,
  hot-swapped over HMR, no server restart and no monorepo rebuild.

## 2. Where code goes — the 5% / 95% rule

**95% — default. A Cordis plugin.** `/home/sf/worlds/exocortex-bundles/<bundle>/`.
Hot-reloaded through HMR in under 500 ms. If a slot or seam exists, use it. Do not edit core.

**5% — exception. Core.** Only for a defect that **no slot can express**, in a `cap/*` branch,
verified on `:3081` before promotion, with `EXO_BOUNDARY_REASON` explaining which seam was checked
and why it cannot express the behavior.

Check `ctx.slots.inject(...)` and the slot table below **before** concluding a slot is missing.
"It was easier in core" is not a reason. A wrong core edit costs more than a slow bundle.

## 3. Slot rules

- **Lowest numeric `priority` wins.** Use `-100`. `priority: 0` collides and throws
  (`packages/client/ui-slots/src/index.ts:774`).
- **Shadowing a node slot replaces it for every case it serves.** A bundle renderer must be a
  **superset** of the kinds it overrides, not just the one you are adding. Test every kind, not one
  screenshot.
- **Factories cannot be shadowed.** A `Factory` slot throws on re-registration
  (`ui-slots/src/index.ts:1026-1028`) and has no priority. If the seat you need is a factory, you
  cannot override it from a bundle — say so instead of editing core quietly.

### Composer

| slot | kind | seat |
|---|---|---|
| `conversation.input.model` | single | model & effort chip (`InputBar.tsx:616`) |
| `conversation.input.overlay` | list | popovers above the input |
| `conversation.input.attachments` | single | attachment strip |
| `conversation.input.left` / `.right` | list | inline composer controls |
| `conversation.input.activity` | single | activity indicator |
| `conversation.input.permission` / `.plan` | single | permission and plan surfaces |
| `conversation.composer.dock` | list | below-composer dock |
| `conversation.input.dock` | list | above-composer dock |

### Transcript

| slot | kind | seat |
|---|---|---|
| `conversation.chat.node` | keyed | one row per node; keys `user`, `steering`, `turn-trigger`, … |
| `conversation.chat.user.content` | factory | user message body (**not shadowable**) |
| `conversation.chat.user.images` | single | child of the above |
| `conversation.chat.flow` | single | the flow container |

**Known gap:** `ChatFlow.tsx:74-78` renders pending submissions and pending steering directly from
`pendingInputs`, **bypassing `conversation.chat.node`**. A `chat.node` override does not cover local
echoes. Tracked as `exo-oik`.

## 4. Structured data only

Slash surfaces read typed OMP RPC frames — `get_available_models`, `get_available_thinking_levels`,
`get_state`, `set_model`, `set_thinking_level`, `compact`, `get_tree`, `navigate_tree`, `branch`,
`fork`. **Never parse ANSI or command text output to build a UI.** Parsed text lies the moment the
format changes. If a frame is missing, request it from `omp_lead` rather than scraping.

## 5. Forbidden outside a `cap/*` branch

`packages/client/**` · `packages/core/**` · `packages/host/**` · `docs/persistence-schema.json` ·
`docs/persistence-catalog.*`

New persistence union members and new client renderers are almost always the wrong answer.
**Enforced mechanically:** `scripts/check-exocortex-boundary.sh <base-ref>` runs as a git
`pre-commit` and `pre-merge-commit` hook and fails the commit. Escape hatch, for a real 5% defect:

```sh
EXO_BOUNDARY_REASON="<the seam you checked and why no slot can express it>" git commit
```

## 6. Commands

Node **v24.22.2** (`/home/sf/.nvm/versions/node/v24.22.2/bin` first on `PATH`), pnpm via Corepack.

```sh
# a bundle
cd /home/sf/worlds/exocortex-bundles/<bundle> && node --test

# the harness, from a worktree
pnpm install && pnpm run typecheck && pnpm run test
pnpm run build:artifacts && pnpm run build:check   # before claiming completion

# staging airlock
curl -s http://10.77.67.147:3081/ > /dev/null
```

Wrap every test and build in a cgroup so a runaway cannot take down the host:

```sh
systemd-run --user --scope -p MemoryHigh=3G -p MemoryMax=4G -p KillMode=control-group -- <cmd>
```

## 7. Staging and production

- **`:3081` is the airlock.** `10.77.67.147:3081`, `DSH_HOME=/home/sf/.dsh-stage`,
  bundles mirrored at `/home/sf/.dsh-stage/exocortex-bundles`. Verify here first, always.
- **`:3080` is live.** `dsh-web.service` on `/home/sf/worktrees/dsh/runtime`. **Never restart it from
  an agent** — it kills child `omp --mode rpc` processes mid-turn and drops the operator's session.
- **`runtime` is never edited directly.** It receives `cap/*` merges only.
- Bundles hot-swap. Write them atomically so a half-written file never gets served; a bundle that
  throws on import takes down the whole shell.

## 8. Style

- Bundle UI uses `--dsw-*` semantic tokens. No hardcoded colors.
- `<500 ms` bundle HMR, `<16 ms` warm switch, `<100 ms` cold first visit (`exocortex-plugin-sla`).
- Errors surface visibly. A rejected model switch or `stopReason: 'error'` gets a red banner with the
  runtime's own message — never a silent success.
- Write in the operator's terms. Status is a receipt: what was observed, what changed, what is
  unverified.
