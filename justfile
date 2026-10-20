# 开发快捷入口。package.json 脚本仍是唯一实现，这里的配方只做转发。
# just 配方名不允许 `:`，所以 `dev:web` 等写作 `dev-web`。

pnpm := "pnpm"

# 本地内核入口：Tauri 壳通过 `DSH_CLI_PATH` 把它识别为本地核心，直接启动本仓库的 dsh。
kernel := justfile_directory() / "desktop-tauri/.local-kernel"

# 默认进入 Web 开发循环。
default: dev-web

# `just dev` 等价于 `just dev-web`。
alias dev := dev-web

# 安装依赖。
install:
    {{pnpm}} install

# 清理构建产物和已删除包留下的安全残留。
clean:
    {{pnpm}} run clean

# 单元测试。
test:
    {{pnpm}} run test

# CI 覆盖率门禁：packages/*/*/src 逐文件 100%。
test-coverage:
    {{pnpm}} run test:coverage

# 真实 API 端到端测试；没有 DEEPSEEK_API_KEY 时自动跳过。
test-e2e:
    {{pnpm}} run test:e2e

# owner-local 进程期望。
test-expected:
    {{pnpm}} run test:expected

# 无密钥的录制会话回放，可用 `just test-snapshot -t <name>` 过滤。
test-snapshot *ARGS:
    {{pnpm}} run test:snapshot {{ARGS}}

# 重新录制快照（需要 API Key）。
test-snapshot-record:
    {{pnpm}} run test:snapshot:record

# 类型检查。
typecheck:
    {{pnpm}} run typecheck

# 代码检查。
lint:
    {{pnpm}} run lint

# 跨文件 TypeScript 克隆检测。
duplication:
    {{pnpm}} run duplication

# 完整构建：build:artifacts + build:check 并行执行。
build:
    {{pnpm}} run build

# 只生成构建产物。
build-artifacts:
    {{pnpm}} run build:artifacts

# 用当前 build:artifacts 输出校验测试与 scripts。
build-check:
    {{pnpm}} run build:check

# 静态门禁：应用入口、Cordis 配置、i18n、unknown 断言等脚本化规则。
check-static:
    {{pnpm}} run check:ci:static

# 完成前检查：类型、lint、构建产物。
verify: typecheck lint build-check

# 发布前卫生检查。
hygiene:
    {{pnpm}} run hygiene

# 文档门禁。
doc-sync:
    {{pnpm}} run doc-sync

# 快速文档检查（不需要构建）。
test-docs:
    {{pnpm}} run test:docs

# 构建文档站（同时检查死链）。
website-build:
    {{pnpm}} run website:build

# 从源码运行一个任务（需要 DEEPSEEK_API_KEY）。
dsh *ARGS:
    {{pnpm}} run dsh {{ARGS}}

# headless PTC 模式运行（需要 API Key）。
demo-ptc *ARGS:
    {{pnpm}} run demo:ptc -- {{ARGS}}

# 只启动 Web，跳过构建。
start-web *ARGS:
    {{pnpm}} run start:web {{ARGS}}

# 仅在诊断已知 Windows 失败时使用（需要 wine）；CI 负责该信号。
check-windows-wine:
    {{pnpm}} run check:windows-wine

# 构建、启动 Web，并在源码改动时重建 client bundle。
dev-web *ARGS:
    {{pnpm}} run dev:web {{ARGS}}

# 生成 Tauri 壳使用的本地内核入口（shim + 包目录链接）。
local-kernel:
    @test -f "{{justfile_directory()}}/apps/cli/lib/bin.js" || { echo "缺少 apps/cli/lib/bin.js，先运行 just build-artifacts"; exit 1; }
    @mkdir -p "{{kernel}}/bin" "{{kernel}}/node_modules/@deepseek-ai"
    @ln -sfn "{{justfile_directory()}}/apps/cli" "{{kernel}}/node_modules/@deepseek-ai/dsh"
    @printf '#!/bin/sh\nexec node "%s/apps/cli/lib/bin.js" "$@"\n' "{{justfile_directory()}}" > "{{kernel}}/bin/dsh"
    @chmod +x "{{kernel}}/bin/dsh"

# 启动 Tauri 桌面：Vite + Tauri dev 窗口，内核使用本仓库的 dsh，并共用 CLI 的 $DSH_HOME。
dev-desktop: local-kernel
    cd desktop-tauri && DSH_HOME="${DSH_HOME:-$HOME/.dsh}" DSH_CLI_PATH="{{kernel}}/bin/dsh" ./node_modules/.bin/tauri dev

# 构建未签名的 debug 桌面应用。
# `--no-default-features` 与 `tauri dev` 对齐；build 模式额外的 `tauri/custom-protocol`
# 特性差异由 Tauri 自身决定。
build-desktop:
    cd desktop-tauri && ./node_modules/.bin/tauri build --debug -- --no-default-features
