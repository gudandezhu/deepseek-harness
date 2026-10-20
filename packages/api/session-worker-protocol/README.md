---
description: "Line-delimited JSON frames that connect a Host supervisor to one session worker over the inherited fd 7 control channel."
kind: "package-reference"
---
# @deepseek-ai/dsh-session-worker-protocol

English | [中文](README.zh.md)

## Summary

Defines the line-delimited JSON frames that connect a Host supervisor to one session worker over the inherited control pipe. It multiplexes unary Connection envelopes, Gateway stream frames, and lifecycle notifications on fd 7, validates frame direction and size, and provides bounded asynchronous queues for both sides.

## Table of Contents

- [Summary](#summary)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Known Limitations and Deferred Work

- Frames are JSON lines with a 64 MiB default cap; there is no compression or binary payload channel.
- The channel requires an inherited fd 7 pipe; it cannot connect over a socket or HTTP.
- Protocol revision 1 offers no capability negotiation beyond the version exchanged during initialize.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
