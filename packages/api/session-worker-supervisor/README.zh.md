---
description: "Host supervisor：为每个 Session 启动一个 session-worker 进程，经 fd 7 转发流量、回收空闲 worker，并等待进程退出。"
kind: "package-reference"
---
# @deepseek-ai/dsh-session-worker-supervisor

[English](README.md) | 中文

## 概述

<a id="summary"></a>

为每个 Host generation 中的每个 Session 启动并管理一个 `session-worker` 子进程。它经 fd 7 转发一元调用和流，跟踪空闲 worker，在 Session 重新启动前等待进程退出，并在 Host 关闭时终止整个进程组。

## 目录

- [概述](#summary)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 没有 worker 池或并发上限：每个活跃 Session 都有自己的进程。
- 崩溃的 worker 不会自动重启；下一次路由请求会启动新 worker。
- 默认命令启动当前 Host 的 CLI 入口；直接使用 supervisor 且入口不同的嵌入方必须配置 `command`，Electron 还需要 `ELECTRON_RUN_AS_NODE=1`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
