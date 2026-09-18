import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(import.meta.dirname, "usage-header.user.js"), "utf8");

test("usage script renders the current provider usage panel", () => {
  assert.match(source, /builtin-2026-09-18-v18/);
  assert.match(source, /\/v1\/usage/);
  assert.match(source, /provider === "owlai"/);
  assert.match(source, /provider === "openox"/);
  assert.match(source, /请求时间/);
  assert.doesNotMatch(source, /Token 命中率/);
  assert.doesNotMatch(source, /命中请求/);
  assert.doesNotMatch(source, /比例/);
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
  assert.match(source, /function updateOpenoxValues\(content\)/);
  assert.match(source, /existingContent\.dataset\.openoxStructure === openoxStructureSignature\(\)/);
  assert.match(source, /if \(state\.status !== "ok"\) setState\(\{ status: "loading"/);
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

test("usage script waits for bridge injection without duplicating the settings RPC", () => {
  assert.match(source, /async function waitForBridge\(/);
  assert.match(source, /waitForBridge\(2500\)/);
  assert.doesNotMatch(source, /api\("\/v1\/usage\/settings"/);
  assert.match(source, /bridgeReady:\s*false/);
  assert.match(source, /正在连接用量插件…/);
  assert.match(source, /用量插件连接超时/);
  // schedule 接受 delayMs 参数，且 refresh 根据本次结果收缩间隔
  assert.match(source, /function schedule\(delayMs\)/);
  assert.match(source, /Number\.isFinite\(delayMs\)/);
  assert.match(source, /nextRetryMs = 500/);
  assert.match(source, /nextRetryMs = 30_000/);
});

test("usage script renders one table per OpenOx KEY with a single shared total", () => {
  // 不再要求 KEY 名称：设置里只剩 Token 输入框
  assert.doesNotMatch(source, /data-openox="keyName"/);
  assert.doesNotMatch(source, /请填写 OpenOx KEY 名称/);
  assert.match(source, /data-openox="token"/);
  assert.match(source, /请在设置中填写 OpenOx Token/);
  // 每个 KEY 一张表，所有 KEY 的合计只作为最后一张表的末行出现
  assert.match(source, /function openoxRowsHtml\(models, totalModels = null\)/);
  assert.match(source, /function openoxTablesHtml\(\)/);
  assert.match(source, /index === keys\.length - 1 \? state\.models : null/);
  assert.match(source, /全部 KEY 合计/);
  assert.match(source, /KEY · /);
  assert.doesNotMatch(source, /crb-key-total/);
  // 分组数据来自后端 payload.keys，并在 state 中维护
  assert.match(source, /openoxKeys/);
  assert.match(source, /openoxKeyCount/);
  assert.match(source, /payload\.keys/);
  assert.match(source, /requestTime: safeText\(item\?\.requestTime\)/);
  assert.match(source, /formatRequestTime\(item\.requestTime\)/);
  // 旧的单表实现已移除
  assert.doesNotMatch(source, /openoxTableHtml\(/);
});

test("usage script keeps the expiry label on one line by folding days into the label", () => {
  // 把"剩 N 天"塞到"有效期"label 末尾，strong 只剩日期，避免数值行被折行
  assert.match(source, /function expiryLabel\(/);
  assert.match(source, /有效[期]\uFF08剩 \$\{days\} \u5929\uFF09/);
  assert.doesNotMatch(source, /formatExpiry\(/);
  assert.match(source, /<span data-summary="expiryLabel">\$\{escapeHtml\(expiryLabel\(state\.periodEnd\)\)\}<\/span><strong data-summary="periodEnd">\$\{escapeHtml\(formatDate\(state\.periodEnd\)\)\}<\/strong>/);
});
