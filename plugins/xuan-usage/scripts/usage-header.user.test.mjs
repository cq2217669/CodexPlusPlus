import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(import.meta.dirname, "usage-header.user.js"), "utf8");

test("usage script renders the current provider usage panel", () => {
  assert.match(source, /builtin-2026-09-18-v10/);
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
