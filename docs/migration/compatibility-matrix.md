# Compatibility Matrix

| Component | Version | Compatible with | Upgrade trigger |
| --- | --- | --- | --- |
| Official CodexPlusPlus | `1.3.0` | Xuan plugins `0.1.x`, `xuan-bridge` `0.1.x`, Remote Bridge `1.0.x` | Validate plugin manifest, User Scripts and renderer request smoke tests |
| `xuan-workspace-search` | `0.1.2` | bridge protocol `1`; MCP `2024-11-05`; user-script ABI `1.0.0` | MCP schema, result shape or top-menu DOM change |
| `xuan-usage` | `0.1.2` | bridge protocol `1`; config schema `1`; user-script ABI `1.0.0` | Provider adapter, credential contract or conversation-header DOM change |
| `xuan-polish` | `0.1.2` | bridge protocol `1`; config schema `1`; user-script ABI `1.0.0` | Composer DOM/bridge URL change |
| `xuan-bridge` | `0.1.0` | plugin protocol `1`; SQLite schema `1` | JSON API or persistent-state migration |
| Remote desktop bridge | `1.0.0` | mobile bridge contract `2.0`; User Script ABI `1.0.0`; remote protocol `2.0` | HTTP, CDP or identity-storage contract change |
| `xuan-plus-remote` app/cloud | `1.0.0` | protocol `2.0` only; cloud SQLite schema `8`; Remote Bridge `1.0.x` | Any public message, pairing, command, task snapshot or cloud storage change |

The official host, plugins and `xuan-bridge` are released independently. The
Remote Bridge, HarmonyOS app and cloud service are a coordinated Remote suite
release. Remote protocol 2.0 does not accept 1.x, and cloud schema 8 does not
read or convert schema 7. User scripts remain the highest-risk official-host
surface and are tested against a small DOM/renderer fixture on every official
release candidate.

## 2026-09-24：客户端消息链路隔离

本节补充旧版仅校验 DOM 的验收方式，不将 Codex++ 1.3.0 与 OpenAI
桌面客户端版本混为一谈。本次现场检查的官方客户端为 `26.917.8451.0`。

历史参考：`b112d79` 将 CDP 桥接请求改为并发处理，现有回归
`install_bridge_keeps_status_responsive_while_generate_is_pending` 覆盖慢请求不阻塞状态查询；
`e06c9fb` 处理桥接重注入退避和陈旧连接；它们不能覆盖全部页面与官方请求入口。

本次约束与修复：

- 请求对象捕获条件始终返回 false；不得暂停官方消息线程或依赖外部进程恢复执行。
- 仅明确需要模型、供应商增强的请求进入补丁。追发、停止、读取及未知请求保留原调用、参数和返回值。
- 插件设置和模型目录读取最多等待两秒；普通 JSON 响应不等待插件目录，增强失败保留原结果。官方请求错误不能触发自动重发。
- 润色按钮重复刷新不重写相同文本、不重复插入自身；页面变更只保留一个待执行扫描。
- 搜索与用量观察器忽略各自 UI 的内部重绘；搜索项目刷新限制为一个并发请求，避免渲染结果再次触发自身查询。
- 四个用户脚本注册清理函数；手机脚本卸载后移除监听、取消待决回调，迟到响应不能重建 UI 或恢复轮询。

验证入口：`plugins/renderer-lifecycle.test.mjs`、各插件的 `scripts/*.test.mjs`、
`apps/codex-plus-manager/src/renderer-inject.test.ts`、
`cargo test -p codex-plus-core --test cdp_bridge`。

隔离浏览器对照中，旧脚本打开搜索后约一秒产生 12 次项目查询，润色按钮空闲
2.2 秒产生 17 次文本变更，手机卸载后有一个 UI 节点重新出现。修复后分别为
2 次、0 次、0 个，四插件同时加载时模拟输入框的 Enter 提交正常。
这是模拟宿主与模拟接口测试，不能替代真实客户端验收，也未复现现场无法续发的完整因果链。

安装后的真机出口：同时加载四个插件，分别验证新任务发送、任务运行中追发、
正常结束后续发、上游断流后续发；比较 Enter 和点击发送，保持插件接口断开时也可发送。
官方更新后重复此验收，未通过前停用有问题的页面增强并保留独立 MCP 功能；
不得通过强制点亮发送按钮、伪造任务结束状态或重放消息掩盖问题。
