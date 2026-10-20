---
description: "会话 worker 的 Host 插件：挂载 supervisor、路由写端点，并维护跨 worker generation 存活的实时 Session 状态。"
kind: "package-reference"
---
# @deepseek-ai/dsh-session-worker-host

[English](README.md) | 中文

## 概述

<a id="summary"></a>

挂载会话进程边界的 Host 侧：worker supervisor、Gateway 查询的端点路由，以及跨 worker generation 存活的实时 Session 状态。Host 保留浏览器的 follow 和 control 流，把写请求路由给所属 worker，并把 Agent、工具、MCP 和 LSP 留在该 worker 内。被路由的 `session/create` 或 `session/fork` 成功后，路由在 Host 注册表中写入新 Session 的工作区归属，其 feed 正是浏览器工作区列表的来源。

## 目录

- [概述](#summary)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 实时状态只保留有界事件环和投影缓存；冷 Session 在配置的 TTL 后过期。
- worker 崩溃会表现为状态变化，下一次 attach 会重置客户端游标；当前回合只会在下一次 resume 时从持久日志修复。
- Electron host 从桌面 runtime 目录派生 worker 命令；argv 约定不同的嵌入方必须显式配置 `command` 和 `ELECTRON_RUN_AS_NODE=1`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
