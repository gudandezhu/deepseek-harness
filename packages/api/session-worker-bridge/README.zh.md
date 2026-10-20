---
description: "worker 侧桥接层：打开继承控制通道、分发转发的 Remote 调用与流、上报空闲，并在关闭前 flush Session。"
kind: "package-reference"
---
# @deepseek-ai/dsh-session-worker-bridge

[English](README.md) | 中文

## 概述

<a id="summary"></a>

在会话 worker 内运行，把 worker 的 Cordis 树连接到 Host supervisor。它打开继承控制通道，通过共享的 `/api` handler 分发转发的一元调用，提供 Gateway 流，上报空闲转换，并在关闭前 flush Session。

## 目录

- [概述](#summary)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 依赖继承的 fd 7 控制管道和 `session-worker` profile；没有独立的 HTTP 入口。
- 空闲判定只观察 Session 日志静默窗口以及 agent、subagent、job 状态；这些信号之外的 activity 不可见。
- 转发的流最多缓冲 `maxUplinkItems` 个上行项；溢出会使该流失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
