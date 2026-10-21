# AGENTS.md

DeepSeek Harness 是全插件 Cordis agent harness。本文件只保留文档地图和铁律；细节以链接文档为准。

<a id="commands"></a>

## 文档地图

| 需要什么 | 去哪里 |
| --- | --- |
| 架构与扩展点 | [docs/architecture.md](docs/architecture.md) |
| 文档规范、双语、字数预算 | [docs/AGENTS.md](docs/AGENTS.md) |
| 开发、测试、构建命令 | [justfile](justfile) |
| 包分组与职责 | [packages/README.md](packages/README.md) |
| 测试、快照、子进程启动模式 | [docs/testing.md](docs/testing.md) |
| 防御性模式 | [docs/defensive-patterns/README.md](docs/defensive-patterns/README.md) |
| 术语与能力缝 | [docs/glossary.md](docs/glossary.md) |
| TypeScript 工程布局 | [docs/development.md](docs/development.md#typescript-project-layout) |
| Session 格式版本与状态 | [docs/session-format-status.md](docs/session-format-status.md) |
| 持久化类型变更评审 | [docs/cookbook/reviewing-persistence-type-changes.md](docs/cookbook/reviewing-persistence-type-changes.md) |
| 推送前检查 | [.agents/skills/dsh-pre-push-checks](.agents/skills/dsh-pre-push-checks/SKILL.md) |
| 错误处理 | [.agents/skills/dsh-error-handling](.agents/skills/dsh-error-handling/SKILL.md) |
| 文档写作 | [.agents/skills/dsh-prose-standard](.agents/skills/dsh-prose-standard/SKILL.md) |
| 升级指南 | [.agents/skills/dsh-create-upgrade-guide](.agents/skills/dsh-create-upgrade-guide/SKILL.md) |
| Agent Note 范围与归档 | [.agents/notes/README.md](.agents/notes/README.md) |
| vendor 同步 | [vendor/README.md](vendor/README.md) |
| Tauri 桌面开发 | [desktop-tauri/docs/DEVELOPMENT.md](desktop-tauri/docs/DEVELOPMENT.md) |

<a id="run-relevant-checks-locally"></a>

<a id="conventions"></a>

## 铁律

1. 公共 API 处于预稳定阶段：改 API 同步所有消费方；外部可感知的破坏性变更当场写升级指南。
2. Session 格式只新增带版本名的后继，禁止移动、覆盖或删除已提交的旧代；SQLite 的 `SCHEMA_VERSION` 单调递增。
3. 插件优先：新行为挂有文档的扩展点；改 `agent-loop` 必须同步更新 [docs/architecture.md](docs/architecture.md)。注册即 effect，waterfall 监听器必须调用 `next()`。
4. 模型可见 ⟺ 已记录：新的模型可见输入必须新增 session 事件。
5. 能力缝必须同时具备 Service Definition、Service Provider、Consumer 三种角色。
6. 插件禁止硬编码可调项；配置错误在最早可解析点报错；同进程类型化边界信任 TypeScript，只在真实边界做运行时校验。
7. 错误用类型化、结构化失败；空 `catch` 写明错误和忽略原因；注释只写本地信息。
8. 测试描述行为；模型或产品用户可见改动更新无密钥录制快照；agent-loop、session 生命周期或 `SessionEventMap` 改动在同一 PR 更新 TypeScript 和 Python SDK 的期望输出。
9. 不默认跑全量测试，不重复已通过的检查；普通任务只跑相关测试，只有较大的重构或改动才在完成前跑 `just verify`。命令因沙箱失败时，用最小范围提权重试原命令，不绕过测试失败或产品沙箱。
10. 代码改动同步更新受影响的 README 和 JSDoc；文档规范遵循 [docs/AGENTS.md](docs/AGENTS.md)。不提交凭据；vendor 更新后跑 `just test` 和 `just build`。
11. 任务完成必须 commit，不得把改动留在工作区；提交前跑通相关测试，提交信息写清改了什么。

可机械检查的规则由 `just check-static`、`just test-docs`、`just verify` 执行，本文件不重复。
