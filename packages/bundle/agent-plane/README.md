---
description: "The shared agent-plane bundle: preset registry, preset declarations, and the base rows presets replace."
kind: "package-bundle"
---
# @deepseek-ai/dsh-agent-plane

English | [中文](README.zh.md)

## Summary

The agent-plane patch layer shared by `dsh-web-app` and `dsh-session-worker`. It disables the base rows that a per-agent preset replaces, mounts `agent-preset-registry`, and declares the `standard`, `ptc`, `minimal`, and `cordis` presets, so both profiles compose the same tools and prompt sections.

## Table of Contents

- [Summary](#summary)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Model Experience

Indirectly, through the presets this layer declares; each preset owns its persona, prompt sections, and tool catalog.

#### KV Cache effect

No direct effect; mounting a preset fixes the request's tool catalog and prompt sections for the Session.

## Known Limitations and Deferred Work

- The layer assumes the profile also mounts the registries presets read (`jobs`, `skill`, `subagent`, `goal`, `token-meter`, `tools`, `commands`). `dsh-base` provides them; a custom profile must keep them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
