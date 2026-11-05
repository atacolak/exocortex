#!/usr/bin/env bash
# Exocortex Cordis plugin boundary gate.
#
# Fails when a diff touches core client surfaces or the persistence schema/catalog.
# Those belong in an @exocortex/* bundle over an existing slot (95%), or in a cap/*
# branch with a genuine upstream defect no slot can express (5%).
#
# Usage:
#   scripts/check-exocortex-boundary.sh <base-ref>          # diff <base-ref>..HEAD
#   scripts/check-exocortex-boundary.sh --staged            # diff --cached
#
# Exemption: set EXO_BOUNDARY_REASON="<why no slot can express this>" for a genuine
# 5% change. The reason is echoed into the output so it lands in the merge record.
set -uo pipefail

FORBIDDEN='^(packages/client/|packages/core/|packages/host/|docs/persistence-schema\.json$|docs/persistence-catalog\.)'

if [ "${1:-}" = "--staged" ]; then
  # A deletion or revert of a forbidden path REMOVES the violation; never block that.
  changed=$(git diff --cached --name-status | awk '$1 != "D" {print $NF}')
else
  base="${1:?usage: $0 <base-ref>|--staged}"
  changed=$(git diff --name-only "$base"..HEAD)
fi

hits=$(printf '%s\n' "$changed" | grep -E "$FORBIDDEN" | sed '/^$/d' || true)

if [ -z "$hits" ]; then
  echo "exocortex-boundary: OK (no core client or persistence-schema paths)"
  exit 0
fi

echo "exocortex-boundary: BLOCKED — this diff touches core surfaces that belong in a plugin:" >&2
printf '  %s\n' $hits >&2

if [ -n "${EXO_BOUNDARY_REASON:-}" ]; then
  echo "" >&2
  echo "Exemption claimed: ${EXO_BOUNDARY_REASON}" >&2
  echo "exocortex-boundary: PASS with exemption (5% case)" >&2
  exit 0
fi

cat >&2 <<'MSG'

Fix one of these ways:
  1. Move the behavior into an @exocortex/* bundle over an existing slot
     (see `ctx.slots.inject(...)` and the registered slot list).
  2. If no slot can express it, re-run with:
       EXO_BOUNDARY_REASON="<the specific line and why no slot exists>" <this command>

Read CHARTER.md §1 before choosing. New persistence union members and new client
renderers are almost always the wrong answer.
MSG
exit 1
