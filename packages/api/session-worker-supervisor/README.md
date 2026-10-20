---
description: "Host supervisor that spawns one session-worker process per Session, forwards traffic over fd 7, reclaims idle workers, and joins process exit."
kind: "package-reference"
---
# @deepseek-ai/dsh-session-worker-supervisor

English | [中文](README.zh.md)

## Summary

Spawns and owns one `session-worker` child per Session for a Host generation. It forwards unary and stream traffic over fd 7, tracks idle workers, joins process exit before a Session respawns, and terminates the process range when the Host shuts down.

## Table of Contents

- [Summary](#summary)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Known Limitations and Deferred Work

- No worker pool or concurrency limit: every active Session gets its own process.
- Crashed workers are not restarted automatically; the next routed request spawns a new worker.
- The default command boots the CLI entry of the running Host; embedders such as Desktop must configure an explicit `command` and `ELECTRON_RUN_AS_NODE=1`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
