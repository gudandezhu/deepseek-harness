---
description: "Worker-side bridge that opens the inherited control channel, dispatches forwarded Remote calls and streams, reports idle, and flushes Sessions before shutdown."
kind: "package-reference"
---
# @deepseek-ai/dsh-session-worker-bridge

English | [中文](README.zh.md)

## Summary

Runs inside a session worker and connects the worker's Cordis tree to the Host supervisor. It opens the inherited control channel, dispatches forwarded unary calls through the shared `/api` handler, serves Gateway streams, reports idle transitions, and flushes Sessions before shutdown.

## Table of Contents

- [Summary](#summary)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Known Limitations and Deferred Work

- Requires the inherited fd 7 control pipe and the `session-worker` profile; it has no standalone HTTP entry.
- Idle reporting observes Session log quiet windows and agent, subagent, and job state; activity outside those signals is invisible to it.
- Forwarded streams buffer at most `maxUplinkItems`; overflow fails that stream.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
