# Development shortcuts. The package.json scripts remain the source of truth.
# `just` does not allow `:` in recipe names, so `dev:web` is `dev-web`.

pnpm := "pnpm"

# 本地内核入口：Tauri 壳通过 `DSH_CLI_PATH` 把它识别为本地核心，直接启动本仓库的 dsh。
kernel := justfile_directory() / "desktop-tauri/.local-kernel"

# Build, serve, and rebuild Web client bundles on source edits.
default: dev-web

# Alias for the default Web development loop.
alias dev := dev-web

# Build, serve, and rebuild Web client bundles on source edits.
dev-web *ARGS:
    {{pnpm}} run dev:web {{ARGS}}

# 生成 Tauri 壳使用的本地内核入口（shim + 包目录链接）。
local-kernel:
    @test -f "{{justfile_directory()}}/apps/cli/lib/bin.js" || { echo "缺少 apps/cli/lib/bin.js，先运行 pnpm run build:artifacts"; exit 1; }
    @mkdir -p "{{kernel}}/bin" "{{kernel}}/node_modules/@deepseek-ai"
    @ln -sfn "{{justfile_directory()}}/apps/cli" "{{kernel}}/node_modules/@deepseek-ai/dsh"
    @printf '#!/bin/sh\nexec node "%s/apps/cli/lib/bin.js" "$@"\n' "{{justfile_directory()}}" > "{{kernel}}/bin/dsh"
    @chmod +x "{{kernel}}/bin/dsh"

# Start the Tauri desktop: Vite plus the Tauri dev window, using this repository's dsh.
dev-desktop: local-kernel
    cd desktop-tauri && DSH_CLI_PATH="{{kernel}}/bin/dsh" ./node_modules/.bin/tauri dev

# Build the Tauri desktop as an unsigned debug app.
# `--no-default-features` matches `tauri dev`; the remaining `tauri/custom-protocol`
# difference is inherent to build mode.
build-desktop:
    cd desktop-tauri && ./node_modules/.bin/tauri build --debug -- --no-default-features
