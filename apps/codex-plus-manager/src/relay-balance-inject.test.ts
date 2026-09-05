import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const script = readFileSync(
  new URL("../../../assets/inject/relay-balance-inject.js", import.meta.url),
  "utf8",
);

test("relay balance uses the protected backend bridge", () => {
  assert.match(script, /callBridge\("\/relay-balance\/query"/);
  assert.doesNotMatch(script, /Authorization\s*:/);
  assert.doesNotMatch(script, /apiKey/);
});

test("relay balance includes usage details and local display preferences", () => {
  assert.match(script, /model_stats/);
  assert.match(script, /cache_creation_tokens/);
  assert.match(script, /actual_cost/);
  assert.match(script, /refreshMinutes/);
  assert.match(script, /rangeDays/);
  assert.match(script, /\/v1\/usage/);
});

test("用量按钮在常规和窄窗口均避开三个窗口控制按钮", () => {
  const rules = [...script.matchAll(/#\$\{ROOT_ID\}\{([^}]+)\}/g)].map((match) => match[1]);
  assert.ok(rules.length >= 2);
  const minimumInset = 3 * 46 + 8;
  assert.match(rules[0], /position:fixed/);
  assert.match(rules[0], /right:\d+px/);
  assert.match(rules[0], /-webkit-app-region:no-drag/);
  for (const rule of rules) {
    const inset = /right:([^;]+)/.exec(rule)?.[1];
    if (inset === undefined) continue;
    assert.match(inset, /^\d+px$/);
    assert.ok(Number.parseInt(inset, 10) >= minimumInset);
  }
});

function loadMonitor(result: unknown = {}, stored: Record<string, unknown> = {}) {
  const end = script.indexOf("  window[API_KEY] = { revision:");
  assert.ok(end > 0);
  const storage = new Map([["codex-plus-relay-balance-config-v1", JSON.stringify(stored)]]);
  const requests: Array<{ path: string; payload: Record<string, unknown> }> = [];
  const sandbox = {
    window: {
      __codexSessionDeleteBridge: async (path: string, payload: Record<string, unknown>) => {
        requests.push({ path, payload });
        return result;
      },
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    setTimeout,
    clearTimeout,
  };
  const api = runInNewContext(`${script.slice(0, end)}
    return {
      parseBalance, formatMoney, calculateSpeed, fetchUsage, todayHtml,
      badgeText, dateRange, saveConfig, settingsHtml,
      assignState: (next) => { state = { ...state, ...next }; },
    };
  })();`, sandbox);
  return { api, requests, storage };
}

test("空余额不能被转换成零，零余额和不限余额仍能识别", () => {
  const { api } = loadMonitor();
  for (const balance of [null, undefined, "", " ", false, [], {}]) {
    assert.throws(() => api.parseBalance({ balance }));
  }
  assert.equal(api.parseBalance({ balance: 0 }).balance, 0);
  assert.equal(api.parseBalance({ balance: "12.5" }).balance, 12.5);
  assert.equal(api.parseBalance({ balance: -1 }).unlimited, true);
  assert.equal(api.formatMoney(null), "--");
  assert.equal(api.formatMoney(0), "$0.00");
});

test("OwlAI 仅展示今日已用，不要求余额与订阅信息", async () => {
  const { api, requests, storage } = loadMonitor({
    status: "ok", provider: "owlai", profileName: "测试中转", data: { todayUsed: 1.2345, unit: "USD" },
  });
  const state = await api.fetchUsage();
  assert.equal(state.provider, "owlai");
  assert.equal(state.balance, null);
  assert.equal(state.speedPerHour, null);
  assert.equal(state.models.length, 0);
  api.assignState(state);
  assert.equal(api.badgeText(), "今日已用 $1.23");
  const html = api.todayHtml();
  assert.match(html, /今日已用/);
  assert.match(html, /\$1.23/);
  assert.doesNotMatch(html, /余额|订阅|累计|倍率|Token|undefined|NaN/);
  assert.equal(requests[0].path, "/relay-balance/query");
  assert.equal(requests[0].payload.timezone, "Asia/Shanghai");
  assert.doesNotMatch(JSON.stringify(requests), /authorization|token|apiKey/i);
  assert.doesNotMatch(JSON.stringify([...storage]), /token|apiKey/i);
});

test("OwlAI 区分零消耗与未提供数据", async () => {
  for (const [value, label] of [[0, "今日已用 $0.00"], [null, "今日已用 暂无数据"]] as const) {
    const { api } = loadMonitor({ status: "ok", provider: "owlai", data: { todayUsed: value } });
    api.assignState(await api.fetchUsage());
    assert.equal(api.badgeText(), label);
    if (value === null) assert.doesNotMatch(api.todayHtml(), /\$0.00/);
  }
});

test("OwlAI 刷新设置不展示接口路径、统计时区或凭据", () => {
  const { api } = loadMonitor();
  api.assignState({ provider: "owlai", settingsOpen: true });
  const html = api.settingsHtml();
  assert.match(html, /刷新间隔/);
  assert.doesNotMatch(html, /usagePath|timezone|token|令牌|密钥/);
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const section = app.slice(app.indexOf('<FeatureGroup title={t("用量监控")}'), app.indexOf('<FeatureGroup title={t("界面与启动")}'));
  assert.match(section, /OwlAI 今日已用/);
  assert.doesNotMatch(section, /OwlToken|登录令牌|type="password"/);
});

test("OwlAI 不受旧通用统计范围和无效时区影响", async () => {
  const { api } = loadMonitor(
    { status: "ok", provider: "owlai", data: { todayUsed: 2 } },
    { timezone: "invalid-timezone", rangeDays: 90 },
  );
  assert.equal((await api.fetchUsage()).todayUsed, 2);
});

test("保留通用余额嵌套响应，并按账户与时间范围隔离消耗速度", async () => {
  const { api } = loadMonitor({
    status: "ok", provider: "generic", profileId: "test-profile",
    data: { data: { balance: 15, model_stats: [{ model: "test-model", actual_cost: 4 }] } },
  });
  const state = await api.fetchUsage();
  assert.equal(state.balance, 15);
  assert.equal(state.models[0].actualCost, 4);
  assert.equal(state.provider, "generic");
  assert.equal(api.calculateSpeed([{ actualCost: 1 }], 1000, "profile-a"), null);
  assert.equal(api.calculateSpeed([{ actualCost: 2 }], 3_601_000, "profile-a"), 1);
  assert.equal(api.calculateSpeed([{ actualCost: 10 }], 7_201_000, "profile-b"), null);
  assert.equal(api.calculateSpeed([{ actualCost: 20 }], 10_801_000, "new-range"), null);
});

test("无效时区提示中文，保存偏好仅保留允许的字段", () => {
  const { api, storage } = loadMonitor({}, { timezone: "invalid-timezone" });
  assert.throws(() => api.dateRange(7), /统计时区无效/);
  api.saveConfig({ timezone: "UTC", refreshMinutes: 200, rangeDays: 30, token: "test-only" });
  const saved = JSON.parse([...storage.values()][0]);
  assert.equal(saved.refreshMinutes, 60);
  assert.equal(saved.rangeDays, 30);
  assert.equal(saved.token, undefined);
  assert.match(api.dateRange(30).startDate, /^\d{4}-\d{2}-\d{2}$/);
});

test("OwlAI 异常数据与无效密钥不会被显示为成功或旧余额", async () => {
  const malformed = loadMonitor({ status: "ok", provider: "owlai", data: {} });
  await assert.rejects(malformed.api.fetchUsage(), /未收到有效的今日用量数据/);
  for (const todayUsed of ["", " ", false, -1, "1.5", {}, []]) {
    const malformed = loadMonitor({ status: "ok", provider: "owlai", data: { todayUsed } });
    await assert.rejects(malformed.api.fetchUsage(), /今日用量数据无效/);
  }
  const { api } = loadMonitor({ status: "failed", provider: "owlai", message: "当前中转密钥无效" });
  api.assignState({ status: "ok", balance: 15, todayUsed: 9 });
  const state = await api.fetchUsage();
  api.assignState(state);
  assert.equal(state.status, "failed");
  assert.equal(state.message, "当前中转密钥无效");
  assert.equal(state.todayUsed, null);
  assert.equal(state.balance, null);
  assert.equal(api.badgeText(), "今日已用 --");
});
