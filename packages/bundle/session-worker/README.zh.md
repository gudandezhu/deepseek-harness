---
description: "session-worker profile bundle：基于 dsh-base 的完整 Session Controller worker，不带 Web 服务器。"
kind: "package-bundle"
---
# @deepseek-ai/dsh-session-worker

[English](README.md) | 中文

## 概述

<a id="summary"></a>

`session-worker` profile bundle：基于 `dsh-base` 的完整 Session Controller worker，不带 Web 服务器或浏览器资源。它挂载 worker bridge、workspace、jobs、上传、API Remotes 和完整的 session controller，使 Host 进程可以拥有浏览器界面并把 Agent 工作委托出去。

## 目录

- [概述](#summary)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

## 模型体验

<a id="model-experience"></a>

间接地，通过它组合的 worker 栈；Agent、工具和 Session 上下文拥有所有模型可见的贡献。

#### KV Cache 影响

没有直接影响；组合后的模型提供方拥有 KV Cache 行为。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 该 bundle 只作为 worker 使用；不暴露 HTTP 界面，也不能作为面向用户的 Web 应用启动。
- 它依赖 Host supervisor 提供继承的 fd 7 控制通道并路由 Session 写请求。
- 工作区归属由 Host 写入：本 profile 以 `attachWorkspaceSessions: false` 创建和分叉 Session，转发调用成功后由 Host 写入归属。
- Electron host 从桌面 runtime 目录派生 worker 命令；不同的嵌入方必须显式配置。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
