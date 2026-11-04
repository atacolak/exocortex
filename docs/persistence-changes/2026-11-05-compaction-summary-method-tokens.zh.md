---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-05-compaction-summary-method-tokens

[English](2026-11-05-compaction-summary-method-tokens.md) | 中文

## 概述

为 compaction/summary 增加可选的压缩方法与压缩后 token 计数，并在 OMP 运行时写入的各个消息来源联合类型中登记 OMP 触发来源类型。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有记录在双向读取时都保持有效。compaction/summary 新增两个可选属性：忽略 method 与 tokensAfter 的读取方仍可依据必需的投影区间与 token 计数识别该边界，未写入这两个字段的写入方仍产生完整的摘要。消息来源联合类型只新增 OMP 自有的类型；既有分支的结构与存在性均不改变，无法识别该类型的消费方本就会回退到通用渲染。由于读取方不会误解旧记录，写入方也无需产出新字段，因此无需提升头部版本号。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/acp/omp-rpc：18 个文件通过，208 个测试通过，1 个跳过。pnpm exec vitest run packages/acp/omp-rpc/tests/live-compaction.spec.ts：10 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
