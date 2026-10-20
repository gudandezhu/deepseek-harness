# Development shortcuts. The package.json scripts remain the source of truth.
# `just` does not allow `:` in recipe names, so `dev:web` is `dev-web`.

pnpm := "pnpm"

# Build, serve, and rebuild Web client bundles on source edits.
default: dev-web

# Alias for the default Web development loop.
alias dev := dev-web

# Build, serve, and rebuild Web client bundles on source edits.
dev-web *ARGS:
    {{pnpm}} run dev:web {{ARGS}}

# Start the vendored Tauri desktop: Vite plus the Tauri dev window.
dev-tauri:
    cd desktop-tauri && {{pnpm}} tauri dev

# Build the vendored Tauri desktop as an unsigned debug app.
build-tauri:
    cd desktop-tauri && {{pnpm}} tauri build --debug

# Forward any command to the vendored Tauri CLI.
tauri *ARGS:
    cd desktop-tauri && {{pnpm}} tauri {{ARGS}}
