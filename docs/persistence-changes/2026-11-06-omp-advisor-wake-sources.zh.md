---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-06-omp-advisor-wake-sources

[English](2026-11-06-omp-advisor-wake-sources.md) | 中文

## 概述

新增 omp-advisor 与 omp-system 消息来源，用于标注进入 user 或 developer 消息来源位的 OMP 顾问建议与未分类 OMP 注入。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

依据 MessageSourceMap 约定，旧读取器会跳过未知来源种类，因此写入这两种来源的会话仍保留完整消息内容，并以无操作者归属的方式呈现该行；读取器不会把它误判为操作者正文，也不会在恢复时截断。新读取器从实时唤醒和冷启动转录恢复两种来源，且不改变既有操作者、唤醒、中继与子代理结算来源的含义。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/acp/omp-rpc：80 个测试通过，含真实 OMP 转录恢复与冷重载。pnpm exec vitest run packages/client/ui-chat：959 个测试通过。pnpm typecheck：host 与 client 编译通过。

<a id="dev-note"></a>
## 开发备注

无。
