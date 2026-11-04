---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-05-compaction-summary-method-tokens

English | [中文](2026-11-05-compaction-summary-method-tokens.zh.md)

## Summary

Adds optional compaction method and post-compaction token count to compaction/summary, and registers the OMP trigger source kinds on every message-source union the OMP runtime appends to.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-05-compaction-summary-method-tokens
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "cb00c41f13c9f084cc91d98091660d055878533e92f8e6162b96035207039e62"
    decision: same-version
  - root: "event:compaction/summary"
    previous: "2026-09-16-session-format-v4"
    after: "87c59e9066558ba620bc0029c732030d89a83a93ae0d0876d0e0afdd26597385"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "0bc4f1803304c7e722b6854e62ada7fb58e4d11e6c061f323ed195703421bd9f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "3bc6b283517df605dc0130496a79975072438b98797d05cb116236ba8755eb74"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "34e6639a0b12c733972d61d78027d77466afede4cece9200e467fb87a45e8fc0"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Older records remain valid in both directions. compaction/summary gains two optional properties: a reader that ignores method and tokensAfter still classifies the boundary from its required shadowed range and token count, and a writer that omits them keeps producing a complete summary. The message-source unions gain OMP-owned kinds only; no existing variant changes shape or disappears, and consumers that do not recognize a kind already fall through to generic rendering. No header version change is needed because no reader can misinterpret an older record and no producer is required to emit the new fields.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/acp/omp-rpc: 18 files passed, 208 tests passed, 1 skipped. pnpm exec vitest run packages/acp/omp-rpc/tests/live-compaction.spec.ts: 10 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
