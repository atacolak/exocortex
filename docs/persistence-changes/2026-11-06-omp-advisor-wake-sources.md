---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-06-omp-advisor-wake-sources

English | [中文](2026-11-06-omp-advisor-wake-sources.zh.md)

## Summary

Adds the omp-advisor and omp-system message sources that attribute OMP advisor guidance and unclassified OMP injections arriving in user or developer message source slots.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-omp-advisor-wake-sources
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-compaction-summary-method-tokens"
    after: "cdc0d9540cfd7f113faf2a50031cb8960651cbd7c815ee886133883ad1685d93"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-compaction-summary-method-tokens"
    after: "21272db89a340abe03b6fed5d455b0a66479d56a0c978f7c58c3dfca59adc478"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-compaction-summary-method-tokens"
    after: "635b1b35b94279fc887602400884cf0cd98b6256d3064d41ba3804d5b8b6b706"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-compaction-summary-method-tokens"
    after: "2032043ffb4b36d5e4a836a5537dafba16bd5901158c01e672a11fdeed78045c"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Older readers fall through unknown source kinds by the MessageSourceMap contract, so a session written with either kind keeps its exact message content and renders the row without operator attribution; no reader misreads the row as operator prose or truncates it during recovery. New readers hydrate both kinds from live wakes and from cold transcript resume, and leave every earlier operator, wake, relay, and settled-subagent source meaning unchanged.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/acp/omp-rpc: 80 tests passed, including the real OMP transcript hydration and cold reload. pnpm exec vitest run packages/client/ui-chat: 959 tests passed. pnpm typecheck: host and client compilers passed.

<a id="dev-note"></a>
## Dev Note

None.
