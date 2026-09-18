import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(import.meta.dirname, "usage-header.user.js"), "utf8");

test("usage script renders the current provider usage panel", () => {
  assert.match(source, /builtin-2026-09-18-v14/);
  assert.match(source, /\/v1\/usage/);
  assert.match(source, /provider === "owlai"/);
  assert.match(source, /provider === "openox"/);
  assert.match(source, /KEY 名称/);
  assert.match(source, /Token 命中率/);
  assert.match(source, /今日可用/);
  assert.match(source, /todayUsed/);
  assert.match(source, /当前供应商用量/);
  assert.doesNotMatch(source, /data-config="baseUrl"/);
  assert.doesNotMatch(source, /OwlAI 今日用量/);
  assert.match(source, /Intl\.DateTimeFormat|Intl\.NumberFormat/);
  assert.match(source, /MutationObserver/);
});

test("usage script updates the result while preserving open settings inputs", () => {
  assert.match(source, /data-crb-toolbar/);
  assert.match(source, /data-crb-content/);
  assert.match(source, /if \(state\.settingsOpen && panel\.querySelector\("\.crb-settings"\)\) \{/);
  assert.match(source, /if \(toolbar\) toolbar\.innerHTML = toolbarHtml\(isToday, rangeLabel\);/);
  assert.match(source, /if \(content\) content\.innerHTML = body;/);
  assert.doesNotMatch(source, /if \(state\.settingsOpen && panel\.querySelector\("\.crb-settings"\)\) return;/);
});

test("usage script uses the independent bridge and keeps credentials out of the renderer", () => {
  assert.match(source, /__xuanPluginBridge/);
  assert.match(source, /用量服务暂时不可用|用量查询失败/);
  assert.match(source, /无法连接用量插件/);
  assert.doesNotMatch(source, /baseUrl: config\.baseUrl/);
  assert.doesNotMatch(source, /Authorization\s*:/i);
  assert.doesNotMatch(source, /bearer\s+\$?\{/i);
  assert.doesNotMatch(source, /localStorage\.setItem\([^\n]*token/i);
  assert.match(source, /type="password"/);
  assert.match(source, /tokenConfigured/);
});

test("usage settings do not masquerade as generic while the bridge is unresolved", () => {
  assert.match(source, /provider: "unknown"/);
  assert.match(source, /bridgeReady: false/);
  assert.doesNotMatch(source, /if \(state\.provider === "unknown"\)/);
  assert.match(source, /if \(!state\.bridgeReady\)/);
  assert.match(source, /当前任务的用量插件连接不可用/);
});

test("usage script probes the bridge before issuing any business RPC", () => {
  // 桥握手探针：未就绪时 fetchUsage 直接返回"正在连接用量插件…"，不会再发 query
  assert.match(source, /async function probeBridge\(/);
  assert.match(source, /probeBridge\(1500\)/);
  assert.match(source, /bridgeReady:\s*false/);
  assert.match(source, /正在连接用量插件…/);
  // schedule 接受 delayMs 参数，且 refresh 根据本次结果收缩间隔
  assert.match(source, /function schedule\(delayMs\)/);
  assert.match(source, /Number\.isFinite\(delayMs\)/);
  assert.match(source, /nextRetryMs = 3000/);
  assert.match(source, /nextRetryMs = 30_000/);
});

test("usage script keeps the expiry label on one line by folding days into the label", () => {
  // 把"剩 N 天"塞到"有效期"label 末尾，strong 只剩日期，避免数值行被折行
  assert.match(source, /function expiryLabel\(/);
  assert.match(source, /有效[期]\uFF08剩 \$\{days\} \u5929\uFF09/);
  assert.doesNotMatch(source, /formatExpiry\(/);
  assert.match(source, /<span>\$\{escapeHtml\(expiryLabel\(state\.periodEnd\)\)\}<\/span><strong>\$\{escapeHtml\(formatDate\(state\.periodEnd\)\)\}<\/strong>/);
});
