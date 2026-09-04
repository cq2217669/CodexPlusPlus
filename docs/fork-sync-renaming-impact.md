# 轩++ 重命名与上游同步评估

日期：2026-09-04

## 改动清单与冲突风险

| 风险 | 文件 |
| --- | --- |
| 高 | `README.md`、`README_EN.md`、`apps/codex-plus-manager/src/App.tsx`、`apps/codex-plus-manager/src/i18n-en.ts`、`assets/inject/renderer-inject.js`、`crates/codex-plus-core/src/install/{mod,windows,macos}.rs`、`scripts/installer/{windows/XuanPlusPlus.nsi,macos/package-dmg.sh}`、`.github/workflows/{pr-build,release-assets}.yml` |
| 中 | `apps/codex-plus-manager/src-tauri/{tauri.conf.json,Info.plist,src/{commands,lib}.rs}`、`apps/codex-plus-launcher/src/main.rs`、`crates/codex-plus-core/src/{app_paths,ccs_import,http_client,model_catalog,protocol_proxy,provider_import,relay_config,share}.rs`、`crates/codex-plus-data/src/provider_sync.rs`、相关 Rust/TS 测试、`package.bat`、`tools/i18n-keys.json` |
| 低 | `CHANGELOG.md`、`CONTRIBUTING.md`、`HANDOVER.md`、`THIRD_PARTY_NOTICES.md`、`docs/` 下历史设计与发布文档、`services/`、`assets/installer/`、Issue 模板与其他纯展示文案 |

高风险文件是上游常改的入口、界面、安装器和 CI 文件；中风险文件包含配置生成与平台集成，虽然上游改动频率较低，但同一字符串附近常被功能改动触及。低风险文件主要是静态文档和展示资源。

## 保留的旧标识

以下不是展示名称，因兼容性或外部引用保留：

- 上游仓库、Release、PR、主题市场和脚本市场的 `BigPizzaV3/CodexPlusPlus*` URL；它们必须指向真实的上游资源。
- `codexplusplus` 深链协议、macOS bundle identifier、Windows 卸载注册表键、macOS 旧可执行文件名，以及 `codex-plus-*` crate、目录和二进制标识；变更会破坏已安装入口、深链、构建依赖或本机状态识别。
- `CodexPlusPlus` 旧 provider ID、Watcher 任务名、旧更新包文件名和 `Codex++` 旧卸载键/备份标记；代码仍读取它们以兼容已有配置、任务和备份。
- 对应的测试 fixture 与断言；它们验证上述历史兼容行为。

新生成的供应商配置、User-Agent、安装包文件名、应用名和界面文本使用 `XuanPlusPlus`、`Xuan++` 或“轩++”。

## 后续同步建议

- 将此重命名保持为独立提交；后续功能提交不要重排同一文件的无关段落。
- 合并或 rebase 上游时优先处理高风险文件，保留本分支的展示文本与兼容键，同时接受上游的功能逻辑。
- 保持品牌常量集中在安装与前端翻译层；若以后需要再次改名，可考虑由构建时品牌配置注入，而非继续扩散字符串替换。
- 在上游 URL、协议、注册表键、crate 名称和历史数据格式上继续采用兼容策略；只有准备好迁移与回滚方案时才改动这些身份标识。
