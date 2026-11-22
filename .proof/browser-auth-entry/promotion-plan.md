# Browser entry host promotion

## Scope and current ownership

This is a separate host repair; Actors remains its independently installed plugin. No named-overlay composition is reconstructed.

- Source: /home/sf/worktrees/dsh/cap/browser-auth-entry-20261122, branch cap/browser-auth-entry-20261122.
- Exact base: 947b7d890333a35a177e52d0fa5d82f59769e1ac, matching the current normal-startup owner.
- Current host: /home/sf/worktrees/dsh/cap/normal-startup-20261119/apps/cli/lib/bin.js with .proof/normal.patch.yml.
- Current service: dsh-web.service, known main PID 66583; recheck immediately before mutation.
- Current Actors: link:/home/sf/worktrees/exocortex-bundles/candidates/actors-refine-20261123/actors, version 0.4.0. Capture the current profile afresh; no pre-0.4 snapshot is an authority.

## Reviewed changes

1. BrowserAuth commits a same-origin 200 document before its one continuation, retaining the existing signed HttpOnly Strict cookie. A missing continuation cookie stops automatic retry. Desktop303, /connect302, origin/host/CSRF policy remain unchanged.
2. frontend-static returns an explicit Response raised by authenticated index rendering. Unexpected exceptions retain the existing400 contract.
3. The deployed exo-overlay host copy returns an honest404 for a missing view with an explicit same-directory Open current workspace link. It removes only the unavailable selector and auth bookkeeping; panel/chat/other queries remain. Valid overlay selection is unchanged.

Source and built artifact hashes: promotion-artifacts.json.
Independent review: independent-review.md.
Actual Firefox proof: firefox-final/receipt.json (11 checks) and overlay-firefox/receipt.json (3 checks).
Final build/test gates: final-gates.json.

## Safety preflight

Before any live change, run capture-preflight.py to a new timestamped receipt. It uses only native plugin-manager list APIs and reads current process metadata. It never sends a chat, attaches a session, changes a model, or restarts an actor.

Require:

- Service KillMode remains exactly process. Native owners including mate and omp_lead share its cgroup; never use kill-whom=all, a cgroup stop, or a broad process kill.
- Capture every live native publication's PID, /proc/PID/stat starttime, and cgroup. Recheck the same identities after the mirror restart.
- Current web ExecStart is the known original90 owner. No existing95-browser-entry override.
- Current bundle and plugin projections, current profile/home patch bytes, and current Actors source are recorded.
- Four reviewed product hashes and final built artifacts still match promotion-artifacts.json.
- Artifact build8/8 and aggregate checks2/2 pass. The original full GUI run records723 green files and9 timeout files; those exact9 pass443/443 with one worker, unchanged timeouts and code. Root explicitly approved this recorded two-run acceptance. The original red receipt remains unchanged.

The OMP bridge implementation and compiled bridge are byte-identical to the original owner. Its default detached/adopted path closes client sockets on disposal and does not signal native owners. Service KillMode=process preserves those owners even when they share the cgroup.

## Switch (only after root coordinates)

1. Install exactly .proof/browser-auth-entry/95-browser-entry-20261122.conf into /home/sf/.config/systemd/user/dsh-web.service.d/. That drop-in changes ExecStart only.
2. Preserve all other drop-ins, DSH_HOME=/home/sf/.dsh, signing store, native run directory, current profile, installed bundles and toggles.
3. systemctl --user daemon-reload, then restart dsh-web.service once. Do not stop any native actor.
4. Candidate command is Node24.22.2 running the cold built apps/cli/lib/bin.js web --patch .proof/promotion.patch.yml --host10.77.67.147 --port3080 --no-open.
5. The promotion patch equals the current normal patch except one exo-overlay module path, pointing to the cold copy. It retains the existing image-chips row and existing overlay settings; it creates no overlay definition.

## Immediate verification

- Candidate web process and port are healthy; no fresh boot error or mount failure.
- New and pre-existing browser cookie entry succeeds. A fresh public cross-site Firefox deep link ends in current Actors or explicit missing-overlay recovery, never a self303 loop.
- Ordinary ?panel=actors renders real Actors0.4.0.
- Missing ?exo_overlay=fable-panes&panel=actors returns explanatory404 with explicit recovery; no silent fallback.
- Current bundle/plugin enabled/source/version projections equal the fresh preimage except the intentional host overlay source if represented there.
- Current profile and toggle file hashes are unchanged.
- Every captured native owner PID/starttime/cgroup remains unchanged. Any failure is reported immediately; no actor is automatically started to hide a loss.

## Rollback

Remove only our95 drop-in, reload systemd, restart only the mirror. Existing90 automatically restores the exact original CLI and normal patch. Never restore an old profile manifest, old toggle snapshot, old bindings, or old actor definition. Recheck native process identities and the current plugin state again. Preserve diagnostic receipts.

Production mutation and final success remain separate from cold proof. This document does not claim deployment.
