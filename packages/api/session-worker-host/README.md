---
description: "Host plugin for per-session workers: supervisor mounting, write-endpoint routing, and live Session state that survives worker generations."
kind: "package-reference"
---
# @deepseek-ai/dsh-session-worker-host

English | [中文](README.zh.md)

## Summary

Mounts the Host side of the per-session process boundary: a worker supervisor, the endpoint router the Gateway consults, and live Session state that survives worker generations. The Host keeps browser follow and control streams, routes writes to the owning worker, and leaves Agent, tools, MCP, and LSP in that worker.

## Table of Contents

- [Summary](#summary)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Known Limitations and Deferred Work

- Live state retains a bounded event ring and projection cache; cold Sessions expire after the configured TTL.
- A worker crash is visible as a status change, and the next attach resets the client cursor; the current turn is repaired from the durable log only on the next resume.
- Desktop and Electron worker startup needs an explicit command; the CLI-derived default does not boot the worker profile from the Desktop host entry.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
