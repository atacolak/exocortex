# @deepseek-ai/dsh-omp-rpc

Bridge between a Harness Agent and one OMP RPC process. The Agent's turn is
served by OMP; every OMP step is projected back into the Harness Session as
ordinary `assistant/message` and `tool/result` events, and selected Harness
tools are published to OMP as discoverable host tools.

## Presets

`discoverOmpPresets` mirrors `omp --agent` discovery: project `.omp/agents`
directories from the working directory upward, then `~/.omp/agent/agents`.
Only the human profiles listed in `HUMAN_OMP_PROFILES` (`argon`, `lead`,
`squad-actor`) enter the Harness roster, as `omp:<profile>`; `argon` sorts
first. A harness preset built this way composes only the Harness discovery
plugins (`cordis_inspect_*`, `plugin_manager`) so OMP's host-tool surface can
see them; OMP serves the whole step.

## Native commands before attach

Every `omp:*` Session receives OMP's real command surface (`/compact`,
`/handoff`, `/security`, `skill:<name>`, …) as soon as it is created, before
any OMP process attaches: the builtin catalog is seeded from OMP's own command
list and `omp skill list --json` is resolved once per working directory
(60 s cache). Invoking one attaches the Session first, then sends the exact
slash line over RPC. `model` stays client-owned and is never shadowed, and a
command OMP actually advertises overrides the pre-populated definition.

## Live session sockets

Every OMP process publishes `~/.omp/run/<sessionId>.sock` plus a `{ pid,
sessionId, sessionFile, cwd, agent, startedAt }` sidecar. The bridge attaches
to that socket directly when a transcript is held by a live TUI/HCOM process,
so `/omp-resume` works against an active OMP session instead of returning
`409`. A socket connection detaches only this client; the owning process, its
transcript, and every other terminal stay alive.

The bridge also polls the run directory (default 1500 ms, immediate startup
scan) and adopts every live publication: it resolves the Harness Session
already bound to that OMP session (never minting a duplicate), otherwise
creates one under the OMP `cwd` workspace with the transcript's `rootAgent`
preset, hydrates the recorded bubbles when the Session is blank, sets the
recorded title, and attaches the socket. Any OMP agent running anywhere on
the machine therefore appears in the sidebar with live status and opens into
its running conversation without typing a command.

## Missing workspace directories

The detached launcher `stat`s the workspace directory before it spawns the
keeper that owns OMP. A Session whose recorded directory no longer exists is
refused instead of started: opening it fails with `workspace directory <path>
no longer exists; relocate this session to an existing directory or forget it`.
The refusal belongs to that Session; the Host and every other Session keep
running. A directory that disappears between the check and the spawn still
arrives as the same per-Session failure because the keeper's `error` event is
observed.

## Slash palette

The bridge publishes no `omp`-prefixed slash command. Live adoption replaces
the old `/omp-attach`, `/omp-resume`, and `/omp-fork` helpers: any OMP session
running on the machine is already mirrored into the sidebar, so the `/` palette
holds only OMP's own native commands plus the session's Harness commands.

Opening a transcript that another OMP pane still holds is refused. Hydration
replays the recorded surface events as real user/assistant/tool bubbles rather
than one seed message: a blank Session receives every turn the transcript's
active branch holds, and an already-mirrored Session appends only the turns
recorded after its persisted cursor, numbered contiguously after the turns it
holds, so a terminal that kept working while the Harness was detached catches up
without duplicating bubbles. The active branch is walked from its newest leaf
through branches, compactions, and dangling parents, while synthetic continue
prompts and memory injections stay out of the transcript. The newest recorded
title is applied whenever it differs from the Session's current title.

Attaching to an existing transcript never replays Harness history into OMP:
every user message the Session already held when the socket or transcript was
attached seeds the driver's delivered baseline, so only messages appended after
attach become `prompt` or `steer` frames. A human prompt typed in an OMP terminal
also lands as an ordinary user message in the Session, without the Harness
echoing the same text back into the live run.

## `POST /api/exocortex/omp/open`

Authenticated Fetch route registered on the Host connection service. It opens a
resolved transcript in a live Session, or creates a Session first.

```json
{ "ompSession": "<id-or-prefix-or-absolute-path>", "sessionId": "<live-session>", "profile": "argon", "cwd": "/abs/dir" }
```

`ompSession` is required. `sessionId` selects an existing Session; without it a
Session is created with `cwd` (or the transcript's recorded cwd) and the
`profile` preset (`omp:<profile>`). Success returns `sessionId`, optional
`agentPreset`, the `ompSession` identity (`id`, `path`, optional `cwd` and
`profile`), `hydrated` event count, and a human `summary`. Errors use
`{ "error": { "code", "message" } }` with 400/404/409/413 statuses for
request, transcript, lease, and body-size failures.

## Configuration

| Key | Default | Purpose |
| --- | --- | --- |
| `executable` | `omp` | OMP binary name or absolute path. |
| `sessionDir` | `~/.omp/agent/sessions` | Transcript root OMP writes into. |
| `ompSessionsRoot` | `~/.omp/agent/sessions` | Root `/omp-resume` and the open route resolve. |
| `preset` | unset | Default `--agent` profile. |
| `hostTools` | `cordis_inspect_list`, `cordis_inspect_query`, `plugin_manager`, `plugin_steward`, `exo_workbench`, … | Discoverable Harness tools published to OMP. |
| `cwd` | unset | Fallback working directory when the Session header has none. |
| `home` | process home | Home owning `~/.omp/agent/agents`. |
| `autoAttach` | true | Attach OMP-preset Sessions on turn 1. |
| `watchRunDir` | `<home>/.omp/run` | Live session publications to adopt; `false` disables adoption. |
| `watchIntervalMs` | `1500` | Adoption poll period. |
| `bindingsFile` | `$DSH_HOME/omp/bindings.json` | Durable Session-to-transcript bindings. |

Both transcript roots intentionally default to the one OMP sessions directory:
an interactive OMP run and a Harness-opened run share transcripts, ids, and
downstream resume links.
