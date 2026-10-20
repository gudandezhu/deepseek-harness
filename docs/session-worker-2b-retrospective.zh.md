# session-worker 阶段二 2b 时间复盘

日期：2026-10-20
分支：`feat/session-worker-idle-reclaim`
范围：阶段二 2b 的实现与验证

## 背景

2b 补齐了 schedule/job 路由、跨进程审批、worker `$events` 聚合、文件上传 receipt、宿主 live-state 上限、崩溃恢复和 Desktop 缺口记录。实际产出 9 个提交，总耗时 80.7 分钟。

## 时间分布

| 项目 | 耗时 | 说明 |
|---|---:|---|
| 两次 upload receipt e2e 挂死 | 18.3 分钟 | 每次约 550 秒，命令等到测试自己结束 |
| 5 次 e2e 120 秒超时 | 约 10 分钟 | `timeout 120` 反复重跑 |
| 一次模型 API 请求 | 5 分钟 | 07:57:48 到 08:02:49，provider/长生成延迟 |
| 其他 60–110 秒停顿 | 约 8 分钟 | 构建、测试、模型回合 |
| 62 次 vitest | 剩余时间 | 其中全量套件 803 用例跑了多次 |
| 15 次 `tsc -b`、16 次 oxlint | — | 多次在小改动后重复执行 |
| 9 个提交、8 次 push、2 次 pnpm install | — | 实际产出 |

## 根因

upload receipt e2e 在 worker A 退出、worker B 拉起后，打开 follow 等 `assistant/message`。冷窗口结束后 follow 没有保持 live 观察，turn 一直不来，测试等到超时。修复提交是 `8f5d31a596`（session follow 冷窗口后保持 live 观察）。第一次 550 秒发生在修复前，第二次发生在修复后仍不稳定的阶段。

## 低效点

- e2e 没有短超时，挂住后只能等 9 分钟。
- 每次改动都跑相关测试加全量套件，重复太多。
- 使用 `npx vitest`，多一层包解析。
- `tsc -b` 跑了 15 次，可以在提交前统一跑一次。
- 跨进程 follow/control 测试缺少显式的帧等待超时和卡点日志，定位靠反复重跑。

## 改进措施

- 所有 e2e 设 60 秒超时；失败立即打印卡点，不等待默认超时。
- 先跑单个测试文件，提交前再跑全量。
- 统一用 `pnpm exec vitest`，不用 `npx`。
- 类型检查和构建放到每个提交前一次，不在每次编辑后跑。
- 跨进程流测试显式给“等待 frame”的 deadline，并输出已收到的 frame 类型。
- 测试启动时断言 `DSH_HOME` 是临时目录，防止污染真实会话库。

## 提交清单

| 提交 | 内容 |
|---|---|
| `366e73d545` | schedule 投递改走 session router |
| `09f226c496` | job/list、job/follow 路由到 owning worker |
| `52a4f13d72` | worker `$events` 聚合与跨进程审批 waterfall |
| `8f5d31a596` | session follow 冷窗口后保持 live 观察 |
| `101d040f9a` | 文件上传 receipt 改为按 sessionId 持久化 |
| `91ef8177e3` | 宿主 live state 增加内存上限 |
| `3e7ff2abef` | worker 崩溃对浏览器可见并在下次 attach 恢复 |
| `b0784178a7` | 记录 Desktop/Electron 的 worker 命令缺口 |
| `ed8c92ee79` | 修复 lint 告警 |
