---
description: "通过继承的 fd 7 控制通道连接 Host supervisor 与单个会话 worker 的按行分隔 JSON 帧。"
kind: "package-reference"
---
# @deepseek-ai/dsh-session-worker-protocol

[English](README.md) | 中文

## 概述

<a id="summary"></a>

定义 Host supervisor 与单个会话 worker 之间通过继承控制管道传输的按行分隔 JSON 帧。它在 fd 7 上复用一元 Connection 信封、Gateway 流帧和生命周期通知，校验帧方向和大小，并为两端提供有界异步队列。

## 目录

- [概述](#summary)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 帧是按行分隔的 JSON，默认上限为 64 MiB；没有压缩或二进制载荷通道。
- 通道依赖继承的 fd 7 管道；不能通过 socket 或 HTTP 连接。
- 协议版本 1 除 initialize 期间交换的版本号外，不提供能力协商。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
