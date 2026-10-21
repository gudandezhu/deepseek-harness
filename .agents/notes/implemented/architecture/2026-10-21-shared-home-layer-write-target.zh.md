# Agent Note: 在 home patch 中编辑共享 home 层条目

Status: implemented

[English](2026-10-21-shared-home-layer-write-target.md) | 中文

## Problem

桌面端与 CLI 的各 profile 通过 `$DSH_HOME/cordis.patch.yml` 共享 provider 路由和默认模型，这一 home 层应用在每个 profile patch 之上。设置表单只读 profile 层：`ConfigEditor.configuration()` 只合成 bundle 与 profile patch，`edit()` 写入 profile patch，并拒绝任何被 home patch 遮蔽的条目。

因此模型设置页会列出一个路由来自实时 Config 的 provider，而它的模型列表来自空的设置层。聊天里能选模型，同一个模型在设置页却不可见；编辑 provider 值会以 `overridden by a higher layer` 失败。请求由一份文档驱动，而表单只能读写另一份。

## Decision

**定义条目的文档就是表单编辑的文档。** 当 home patch 为某个条目携带 config 行时，该行就是表单的用户层：`configuration()` 把它的 config 作为 `override` 返回，把它下方合成出的 config（bundle 加 profile patch）作为 `inherited` 返回，`edit()` 写入 home patch。其余条目仍以 profile patch 为写入目标。

- **读取。** 模型设置页现在从 home 行读取 `providers.<route>.models`，共享层声明的路由会显示聊天可选的模型。继承值来自 home 层下方的合成，因此重置会删除 home 行的 `config` 并回落到 profile 或 bundle 值。
- **写入。** home patch 中存在带 `config` 的 `id` 行时，`ConfigEditor.edit()` 选择 home 文档，否则选择 profile 文档。home 写入持有 home 文档自己的写入锁，而不是 profile 清单锁，因为所有 profile 共用该文档。候选值通过 `readProfilePatches(..., homePatches)` 代入被编辑文档后，在完整 patch 列表上校验；仍遮蔽该条目的命令行 overlay 继续让写入被拒绝。协调失败会还原被编辑的文档。
- **范围。** 规则适用于所有设置条目，而不仅是模型 provider：home patch 正是 [profile 所有的配置笔记](2026-09-19-profile-owned-live-configuration.zh.md) 为重新引入跨 profile 偏好所点名的显式共享层，共享关系对编辑它的表单可见。
- **桌面端配置入口。** 模型设置页的「打开配置文件」打开 `$DSH_HOME/cordis.patch.yml`，即它的编辑所落到的文件，而不是已移除的 `settings.yaml`。

## Alternatives considered

**只读展示 home 值，仍以 profile 为唯一写入目标。** 显示会正确，但编辑共享 provider 仍需手改文件，表单仍是第二个读取方，无法维护它展示的值。

**把 provider 路由搬进每个 profile patch。** 不需要核心改动，但桌面端和 CLI 从此各维护一份副本，同一个模型可能漂移——这正是 home 层要消除的割裂。

**让 home 层优先级低于 profile patch。** profile 编辑会生效，但当 profile 存在对应行时，共享值会静默失效，home 文件不再是唯一权威位置。

**把所有设置都写入 home patch。** 这会把无关的 per-profile 配置变成全局配置。写入目标跟随条目，因此只有已声明在 home 文档中的条目才变成共享。

## Consequences

声明在共享 home 文档中的路由或模型在桌面端模型设置页可见且可编辑，编辑落到 CLI 读取的同一份文件。profile 专属值仍留在各自 profile。对共享条目执行重置会删除 home 行的 config，而不是把 home 层下方的值复制到另一份文件。

代价是：

- 定义在 home patch 中的条目不能再通过表单按 profile 覆盖；profile 仍可保留对应行，但在 home 行被移除前，home 层胜出。
- 对这些条目，设置页编辑的是全局文档，因此一个用户的改动会到达机器上的每个 profile。
- home patch 必须保持 patch 行序列，并沿用 Loader 已要求的唯一 id 或后者胜出语义。

## Testing

[configuration.spec.ts](../../../../packages/settings/settings/tests/configuration.spec.ts) 写入 home 行，断言描述符中的 `user` 与 `base`，通过 Settings 编辑，检查 home 文档变化而 profile 文档不变，并通过移除 home 行的 config 把值重置回 bundle 默认值。
