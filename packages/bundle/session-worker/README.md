---
description: "The session-worker profile bundle: a complete Session Controller worker over dsh-base with no Web server."
kind: "package-bundle"
---
# @deepseek-ai/dsh-session-worker

English | [中文](README.zh.md)

## Summary

The `session-worker` profile bundle: a complete Session Controller worker over `dsh-base`, with no Web server or browser assets. It mounts the worker bridge, workspace, jobs, uploads, API Remotes, and the full session controller so a Host process can own the browser surface and delegate Agent work.

## Table of Contents

- [Summary](#summary)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Model Experience

Indirectly, through the composed worker stack, whose Agent, tools, and Session context own every model-visible contribution.

#### KV Cache effect

No direct effect; the composed model provider owns KV-cache behavior.

## Known Limitations and Deferred Work

- The bundle only serves as a worker; it exposes no HTTP surface and cannot launch as the user-facing Web app.
- It expects the Host supervisor to provide the inherited fd 7 control channel and to route Session writes.
- Desktop needs an explicit worker command because the Desktop host entry is not the CLI entry.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
