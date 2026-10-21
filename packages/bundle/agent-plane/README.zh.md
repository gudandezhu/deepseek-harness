---
description: "共享 agent-plane bundle：preset 注册表、preset 声明，以及被 preset 取代的 base 行。"
kind: "package-bundle"
---
# @deepseek-ai/dsh-agent-plane

[English](README.md) | 中文

## 概述

<a id="summary"></a>

由 `dsh-web-app` 与 `dsh-session-worker` 共用的 agent-plane 补丁层。它禁用被每-agent preset 取代的 base 行，挂载 `agent-preset-registry`，并声明 `standard`、`ptc`、`minimal`、`cordis` 四个 preset，使两个 profile 组合出相同的工具与提示词段落。

## 目录

- [概述](#summary)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

## 模型体验

<a id="model-experience"></a>

间接地，通过本层声明的 preset；每个 preset 拥有自己的 persona、提示词段落与工具目录。

#### KV Cache 影响

没有直接影响；挂载 preset 会固定该 Session 请求的工具目录与提示词段落。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 本层假设 profile 同时挂载 preset 读取的注册表（`jobs`、`skill`、`subagent`、`goal`、`token-meter`、`tools`、`commands`）。`dsh-base` 提供它们；自定义 profile 必须保留。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
