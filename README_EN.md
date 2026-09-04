# Xuan++

Xuan++ (轩++) is a local launcher and manager for the OpenAI Codex / ChatGPT desktop app. It uses the Chromium DevTools Protocol and local helpers for provider switching, protocol conversion, session management, and optional UI enhancements without modifying the official app's `app.asar` or installation directory.

This repository is intended for personal local use only.

## Features

- Manage official-login, mixed-API, pure-API, and aggregate-provider profiles.
- Configure per-model context windows and auto-compaction limits through `model_catalog_json`.
- Manage sessions, MCP servers, Skills, Plugins, scripts, themes, and local diagnostics.
- Launch the official desktop app through Xuan++ with saved settings and optional enhancements.

## Install and Run

### Prerequisites

- Rust toolchain.
- Node.js and npm.
- The OpenAI Codex / ChatGPT desktop app for launch and injection features.

### Development

```powershell
cd apps/codex-plus-manager
npm ci
npm run check
npm run dev
```

### Build and Test

```powershell
cd apps/codex-plus-manager
npm run check
npm run vite:build

cd ../..
cargo fmt --all -- --check
cargo test
cargo build --release
```

### Use

In the manager, confirm the official desktop app path and save provider and enhancement settings. Launch the app through Xuan++. Provider configuration, session data, and diagnostics remain local; do not place API keys in logs, screenshots, or commits.

## Data Locations

- Codex config: `~/.codex/config.toml`
- Codex auth state: `~/.codex/auth.json`
- Codex local database: prefers `~/.codex/sqlite/*.db`, then falls back to legacy `~/.codex/state_5.sqlite`
- Xuan++ state and logs: `~/.codex-session-delete/`
- Provider Sync backups: `~/.codex/backups_state/provider-sync`

## Compatibility

Xuan++ depends on the official desktop app's page structure, CDP behavior, and local data formats. Official app updates may require injection updates. Back up provider configuration and local session data before changing them.

## License

Copyright (C) 2026 BigPizzaV3

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE), SPDX identifier `AGPL-3.0-only`. The license does not grant rights to OpenAI, ChatGPT, Codex trademarks, application assets, or other third-party content.
