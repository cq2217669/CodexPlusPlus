# 轩++

轩++（Xuan++）是面向 OpenAI Codex / ChatGPT 桌面应用的本机启动器与管理工具。它通过 Chromium DevTools Protocol 和本地辅助服务完成供应商切换、协议转换、会话管理与界面增强，不修改官方应用的 `app.asar` 或安装目录。

本仓库仅供个人本机使用。

## 功能

- 管理官方登录、混入 API、纯 API 与聚合供应商配置。
- 为模型配置上下文窗口和自动压缩阈值，并生成 `model_catalog_json`。
- 管理会话、MCP、Skill、Plugin、脚本、主题与本机诊断。
- 通过 Xuan++ 启动官方桌面应用并按已保存配置注入可选增强。

## 安装与运行

### 前置条件

- Rust 工具链。
- Node.js 与 npm。
- 已安装 OpenAI Codex / ChatGPT 桌面应用（使用启动和注入功能时需要）。

### 开发运行

```powershell
cd apps/codex-plus-manager
npm ci
npm run check
npm run dev
```

### 构建与测试

```powershell
cd apps/codex-plus-manager
npm run check
npm run vite:build

cd ../..
cargo fmt --all -- --check
cargo test
cargo build --release
```

### 使用

在管理工具中确认官方桌面应用路径，保存供应商和增强设置后，从 Xuan++ 入口启动应用。供应商配置、会话与诊断均保存在本机；请不要将 API Key 写入日志、截图或提交记录。

### 微信 ClawBot 对外入口

微信连接的扫码二维码仅用于绑定 iLink Bot，不能转发给其他人。若微信/iLink 或你自己的服务已提供公开会话 URL，可在“微信连接”中填写“对外会话链接”，再使用复制按钮发送给受邀用户；该设置不会分享 token、登录二维码或本机配置。完整的能力边界、微信官方前置条件和配置说明见 [微信 ClawBot 分享说明](docs/weixin-clawbot-sharing.md)。

## 数据位置

- Codex 配置：`~/.codex/config.toml`
- Codex 登录状态：`~/.codex/auth.json`
- Codex 本地数据库：优先读取 `~/.codex/sqlite/*.db`，旧版回退到 `~/.codex/state_5.sqlite`
- 轩++ 状态与日志：`~/.codex-session-delete/`
- Provider Sync 备份：`~/.codex/backups_state/provider-sync`

## 兼容性

轩++依赖官方桌面应用的页面结构、CDP 和本地数据格式。官方应用更新后，部分注入功能可能需要适配；修改供应商配置或本地会话数据前应保留备份。

## 许可证

Copyright (C) 2026 BigPizzaV3

本项目采用 [GNU Affero General Public License v3.0](LICENSE)，SPDX 标识为 `AGPL-3.0-only`。许可证不授予 OpenAI、ChatGPT、Codex 的商标、应用资源或其他第三方内容的权利。
