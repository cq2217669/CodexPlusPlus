# 同步上游：冲突成因与处理规程

本 fork 需要持续跟进 `BigPizzaV3/CodexPlusPlus:main`。本文记录冲突为什么反复出现、
哪些已经自动化、哪些仍需人工判断。

## 一、冲突清单

以 `0b8ba5f → 41048a2` 这次同步为例（123 个文件变更）：

| 文件 | 性质 | 处理方式 |
| --- | --- | --- |
| `assets/inject/renderer-inject.js` | **假冲突**：脚本从分片生成的产物 | 自动重建，不手工合并 |
| `assets/inject/renderer-inject/70-model-catalog.js` | **真冲突**：本地门控与上游 `sendRequest` 补丁演进在同一批函数里 | 人工语义对齐 |
| `assets/inject/renderer-inject/00-prelude.js` | 通常可自动合并 | 核对补丁版本号 |
| `crates/codex-plus-core/tests/cdp_bridge.rs` | 通常可自动合并 | 核对补丁版本号断言 |
| `crates/codex-plus-core/src/bridge.rs` | 上游近期未改动 | 若改动则核对断点条件语义 |
| `apps/codex-plus-manager/src/renderer-inject.test.ts` | 通常可自动合并 | 本地 describe 块与上游用例互不重叠 |

结论：**真正需要人判断的只有一个文件**——`70-model-catalog.js`。

## 二、根因

`renderer-inject.js` 已从单体文件改为「分片源码 + 生成产物」：

- 唯一真实来源是 `assets/inject/renderer-inject/*.js` 分片 + `manifest.json`
- 产物由 `node scripts/assemble-renderer-inject.mjs` 拼接生成
- `renderer-inject.test.ts` 有「分片与产物逐字节一致」用例把守

我们改了 `70-model-catalog.js` 里上游正在高频重构的两个函数：

- `patchAppServerModelRequestClient`（实例补丁）
- `installCodexAppServerClientPrototypePatch`（原型补丁）

上游每次给这两个函数的 `sendRequest` 加功能，就会和我们重写的版本撞车。
这是结构性的，不会因为某次解得好而消失。

## 三、已自动化

跑一次即可安装（配置都写在本地，不进版本库，因此不与上游 `.gitattributes` 冲突）：

```bash
node scripts/fork-sync-setup.mjs
```

安装内容：

1. **产物合并策略**：`.git/info/attributes` 里 `assets/inject/renderer-inject.js merge=ours`
   ——产物不再产生冲突。
2. **产物重建**：`core.hooksPath=scripts/git-hooks`，`pre-commit` 钩子每次提交前
   按分片重建产物并 `git add`，保证产物与分片始终一致。
3. **rerere**：`rerere.enabled=true` + `rerere.autoupdate=true`，记录一次冲突解决
   过程，同形态冲突自动重放。

之后同步上游：

```bash
node scripts/sync-upstream.mjs          # 合并并停在与 commit 之前供复核
node scripts/sync-upstream.mjs --full   # 额外跑 cargo 侧 cdp_bridge 测试
```

脚本会：fetch → merge → 用 rerere 重放 → 重建产物 → 跑验证 → 报告仍待人工处理的文件。

## 四、仍需人工判断的部分

### 4.1 `70-model-catalog.js` 的语义对齐

本地保留的能力（不可丢）：

- **同步门控** `codexAppServerRequestNeedsPatch`：追发、停止、读取及未知请求
  保持官方同步调用与返回值，不进入插件异步链。
- **增强异常隔离** `sendPatchedCodexAppServerRequest`：增强步骤抛错时退回官方原始
  参数，且官方请求只发一次。

上游新增的能力（必须吸收）：

- `codexPlusPluginNativeInterceptClient` 插件原生请求拦截
- `registerNativeHostClient`、`modelResponseHostId`

**关键顺序规则**：插件拦截必须排在门控**之前**。插件方法（`plugin/read`、
`plugin/installed` 等）不在门控白名单里，顺序反过来它们会被当作普通请求直通官方
接口，绕过插件层。`renderer-inject.test.ts` 里有两条用例（实例 + 原型）把守这条不变量。

**依赖超时只保留一层**：`readCodexAppServerPreparation` 与 `loadCodexModelCatalog`
都已内置 2000ms 超时并在超时后丢弃迟到结果。不要再套第二层同延迟竞速——外层定时器
会先于读取层结算，反而把迟到结果放进来。

### 4.2 补丁版本号

`codexAppServerModelRequestPatchVersion`（`00-prelude.js`）由本 fork 拥有，用于判断
已打过补丁的 client 是否需要重打。**只要补丁语义变了就要递增**，并同步更新
`cdp_bridge.rs` 里的断言。上游自己维护的 `codexPluginMarketplaceUnlockVersion`
等版本号不要动。

## 五、验证入口

| 目的 | 命令 |
| --- | --- |
| 产物与分片一致 | `node scripts/assemble-renderer-inject.mjs --check` |
| 门控 / 隔离 / 插件拦截顺序 | `node --test apps/codex-plus-manager/src/renderer-inject.test.ts` |
| 注入脚本与桥接契约 | `cargo test -p codex-plus-core --test cdp_bridge` |
| 插件注入通道 | `cargo test -p codex-plus-core --test user_scripts_reload` |
| 四插件自身 | `node --test plugins/*/scripts/*.test.mjs` |

## 六、真正的「一劳永逸」

自动化能消掉假冲突、能重放已记录的解决方案，但**消不掉 `70-model-catalog.js` 的
语义冲突**——只要上游继续重构那两个函数，每次都要对齐一次。

要彻底消除，只有一条路：**把本地这层改动提 PR 合进上游**。门控 + 异常隔离是通用
改进（任何增强链路挂起都不该阻塞官方消息发送），与上游的插件拦截、超时机制并不
冲突，具备被接受的基础。合并后本 fork 在这些文件上不再偏离，冲突永久消失。

在此之前，建议把每次人工对齐都当作一次「本地改动面积是否还能再缩小」的复盘机会：
偏离越小，rerere 命中率越高，人工成本越低。
