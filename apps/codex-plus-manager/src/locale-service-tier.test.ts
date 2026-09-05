import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { stripTypeScriptTypes } from "node:module";

const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");

function section(start: string, end: string) {
  const from = renderer.indexOf(start);
  const to = renderer.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return renderer.slice(from, to);
}

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

async function localeHarness(options: { enabled?: boolean; failures?: number; malformed?: boolean; syncThrow?: boolean; previous?: string | null } = {}) {
  let now = 0;
  let nextId = 0;
  let failures = options.failures ?? 0;
  let current: string | null = options.previous ?? "en-US";
  let reloads = 0;
  const writes: unknown[] = [];
  const listeners = new Set<(event: unknown) => void>();
  const timers = new Map<number, { at: number; fn: () => void; interval?: number }>();
  const setTimer = (fn: () => void, delay: number, interval?: number) => {
    const id = ++nextId;
    timers.set(id, { at: now + delay, fn, interval });
    return id;
  };
  class FakeNavigator {}
  const windowValue: any = {
    __CODEX_PLUS_FORCE_CHINESE_LOCALE__: { enabled: options.enabled !== false, locale: "zh-CN" },
    localStorage: storage(),
    sessionStorage: storage(),
    location: { reload: () => { reloads++; } },
    addEventListener: (_: string, fn: (event: unknown) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (event: unknown) => void) => listeners.delete(fn),
    setTimeout: (fn: () => void, delay: number) => setTimer(fn, delay),
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (fn: () => void, delay: number) => setTimer(fn, delay, delay),
    clearInterval: (id: number) => timers.delete(id),
    electronBridge: {
      sendMessageFromView(message: any) {
        if (failures-- > 0) {
          if (options.syncThrow) throw new Error("test bridge unavailable");
          return;
        }
        const params = JSON.parse(message.body);
        assert.equal(params.key, "localeOverride");
        assert.equal(Object.hasOwn(params, "params"), false);
        const setting = message.url.endsWith("/set-setting");
        if (setting) {
          current = params.value;
          writes.push(current);
        }
        const event = { data: {
          type: "fetch-response", requestId: message.requestId, responseType: "success",
          bodyJsonString: JSON.stringify(options.malformed ? {} : setting ? null : { value: current }),
        } };
        for (const listener of [...listeners]) listener(event);
      },
    },
  };
  const run = new Function("window", "Navigator", "navigator", "globalThis", "crypto", "Date",
    `${section("  function installCodexPlusForceChineseLocale()", "\n  installCodexPlusFastStartup();")}
     return installCodexPlusForceChineseLocale;`);
  const install = run(windowValue, FakeNavigator, new FakeNavigator(), windowValue,
    { randomUUID: () => `request-${++nextId}` }, { now: () => now });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const tick = async (duration: number) => {
    const until = now + duration;
    await flush();
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      now = timer.at;
      timers.delete(id);
      if (timer.interval) timers.set(id, { ...timer, at: now + timer.interval });
      timer.fn();
      await flush();
    }
    now = until;
    await flush();
  };
  install();
  await flush();
  return { windowValue, install, tick, writes, timers, listeners, reloads: () => reloads, current: () => current };
}

describe("中文界面启动与恢复", () => {
  it("桥接请求体直接传递语言参数，成功写入后才刷新", async () => {
    const h = await localeHarness();
    assert.deepEqual(h.writes, ["zh-CN"]);
    assert.equal(h.current(), "zh-CN");
    assert.equal(h.reloads(), 1);
    assert.equal(h.windowValue.__codexPlusForceChineseLocaleStatus, "enabled");
    assert.equal(h.listeners.size, 0);
  });

  it("首次超时后重试并切换为中文，清理响应监听器", async () => {
    const h = await localeHarness({ failures: 1 });
    assert.equal(h.reloads(), 0);
    await h.tick(6100);
    assert.deepEqual(h.writes, ["zh-CN"]);
    assert.equal(h.reloads(), 1);
    assert.equal(h.windowValue.__codexPlusForceChineseLocaleStatus, "enabled");
    assert.equal(h.listeners.size, 0);
  });

  it("同步抛错也清理计时器并重试", async () => {
    const h = await localeHarness({ failures: 1, syncThrow: true });
    await h.tick(1100);
    assert.deepEqual(h.writes, ["zh-CN"]);
    assert.equal(h.listeners.size, 0);
  });

  it("畸形响应不覆盖原语言，失败重试有上限", async () => {
    const h = await localeHarness({ malformed: true });
    await h.tick(70000);
    assert.deepEqual(h.writes, []);
    assert.equal(h.current(), "en-US");
    assert.equal(h.reloads(), 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.windowValue.__codexPlusForceChineseLocaleStatus, "failed");
  });

  it("关闭强制中文会恢复原语言，不覆盖用户后来手动改过的语言", async () => {
    const h = await localeHarness();
    h.windowValue.__CODEX_PLUS_FORCE_CHINESE_LOCALE__.enabled = false;
    h.install();
    await h.tick(0);
    assert.deepEqual(h.writes, ["zh-CN", "en-US"]);
    assert.equal(h.windowValue.localStorage.getItem("codexPlus.forceChineseLocale.managed.v1"), null);

    const manual = await localeHarness({ enabled: false, previous: "ja-JP" });
    manual.windowValue.localStorage.setItem("codexPlus.forceChineseLocale.managed.v1",
      JSON.stringify({ appliedLocale: "zh-CN", previousValue: "en-US" }));
    manual.windowValue.__codexPlusForceChineseLocaleInstalled = "";
    manual.install();
    await manual.tick(0);
    assert.deepEqual(manual.writes, []);
    assert.equal(manual.current(), "ja-JP");
  });

  it("已经是中文时不刷新，五秒后出现的国际化客户端仍能补丁", async () => {
    const h = await localeHarness({ previous: "zh-CN" });
    h.windowValue.__STATSIG__ = { instances: {} };
    await h.tick(10000);
    const events: unknown[] = [];
    const client = {
      getDynamicConfig: (_name: string) => ({ value: { enable_i18n: false } }),
      $emt: (event: unknown) => events.push(event),
    };
    h.windowValue.__STATSIG__.instances.late = client;
    await h.tick(250);
    assert.equal(client.getDynamicConfig("72216192").value.enable_i18n, true);
    assert.deepEqual(events, [{ name: "values_updated" }]);
    assert.equal(h.reloads(), 0);
    await h.tick(60000);
    assert.equal(h.timers.size, 0);
    assert.equal(events.length, 1);
  });

  it("等待重试时关闭功能，不再写入中文设置", async () => {
    const h = await localeHarness({ failures: 1 });
    await h.tick(5000);
    h.windowValue.__CODEX_PLUS_FORCE_CHINESE_LOCALE__.enabled = false;
    h.install();
    await h.tick(70000);
    assert.deepEqual(h.writes, []);
    assert.equal(h.timers.size, 0);
    assert.equal(h.windowValue.__codexPlusForceChineseLocaleStatus, "disabled");
  });
});

function fastHarness() {
  const context = {
    codexPlusBackendStatus: { status: "ok" },
    codexServiceTierState: { status: "ok", controlMode: "inherit", effectiveMode: "standard", effectiveServiceTier: null },
    model: "gpt-5.5",
    metadata: {} as Record<string, any>,
    badges: [{ dataset: {}, setAttribute(name: string, value: string) { (this as any)[name] = value; } }],
  };
  const code = [
    section("  function codexServiceTierFastSupportedForModel(", "\n  function codexServiceTierFastUnsupportedMessage("),
    section("  function codexServiceTierFastAvailability(", "\n  function codexServiceTierInheritedValue("),
    section("  function serviceTierGlobalStatusMessage(", "\n  function readThreadServiceTierState("),
    section("  function codexServiceTierBadgeState(", "\n  function refreshCodexServiceTierControls("),
  ].join("\n");
  const api = new Function("context", `
    const { codexPlusBackendStatus, codexServiceTierState } = context;
    const codexServiceTierSupportedFastModels = new Set(["gpt-5.5"]);
    const normalizeCodexServiceTierModelName = value => String(value || "").trim().toLowerCase();
    const codexServiceTierCurrentModelName = () => context.model;
    const codexPlusModelMetadata = model => context.metadata[model];
    const document = { querySelectorAll: () => context.badges };
    ${code}
    return { availability: codexServiceTierFastAvailability, badge: codexServiceTierBadgeState, refresh: refreshCodexServiceTierBadges };
  `)(context);
  return { context, api };
}

describe("Fast 入口与状态", () => {
  it("模型元数据和固定名单均能启用入口，未知模型不猜测支持", () => {
    const { context, api } = fastHarness();
    assert.equal(api.availability().supported, true);
    context.model = "custom-model";
    assert.equal(api.availability().supported, false);
    context.metadata[context.model] = { serviceTiers: [{ id: "priority" }] };
    assert.equal(api.availability().supported, true);
  });

  it("明确展示关闭、开启、未生效及不可用状态", () => {
    const { context, api } = fastHarness();
    assert.equal(api.badge().label, "Fast：已关闭");
    context.codexServiceTierState.effectiveMode = "fast";
    api.refresh();
    assert.equal(api.badge().label, "Fast：已开启");
    assert.equal((context.badges[0] as any)["aria-pressed"], "true");
    context.model = "unknown";
    api.refresh();
    assert.equal(api.badge().label, "Fast：未生效");
    assert.equal((context.badges[0] as any)["aria-pressed"], "false");
    assert.equal(api.badge().disabled, undefined);
    context.codexServiceTierState.effectiveMode = "standard";
    assert.equal(api.badge().label, "Fast：不可用");
    assert.equal(api.badge().disabled, true);
  });

  it("读取失败和断线不显示为已开启，并禁止切换", () => {
    const { context, api } = fastHarness();
    context.codexServiceTierState.effectiveMode = "fast";
    context.codexServiceTierState.status = "failed";
    assert.equal(api.badge().label, "Fast：状态未知");
    assert.equal(api.badge().disabled, true);
    context.codexPlusBackendStatus.status = "failed";
    api.refresh();
    assert.equal((context.badges[0] as any)["aria-disabled"], "true");
  });
});

const i18nSource = await readFile(new URL("./i18n.ts", import.meta.url), "utf8");
const i18nCode = stripTypeScriptTypes(i18nSource.replace(/^import .+;$/m, "")).replace(/\bexport /g, "");
function managerLanguageHarness(value: string | null, writable = true, href = "http://localhost/?view=settings#language") {
  const saved = storage();
  if (value) saved.setItem("codex-plus-lang", value);
  let reloads = 0;
  const windowValue = {
    localStorage: {
      ...saved,
      setItem(key: string, language: string) {
        if (!writable) throw new Error("storage unavailable");
        saved.setItem(key, language);
      },
    },
    location: { href, reload: () => { reloads++; }, replace(url: string) { this.href = url; } },
  };
  const api = new Function("window", `
    const EN_PLAIN = { "测试": "Test" }, EN_BACKEND = {}, EN_TEMPLATE = {}, EN_BACKEND_PATTERNS = [];
    ${i18nCode}
    return { getLanguage, setLanguage, t };
  `)(windowValue);
  return { windowValue, api, reloads: () => reloads };
}

describe("管理器语言偏好", () => {
  it("首次启动默认中文，只有明确英文偏好才显示英文", () => {
    assert.equal(managerLanguageHarness(null).api.getLanguage(), "zh");
    assert.equal(managerLanguageHarness("invalid").api.getLanguage(), "zh");
    const h = managerLanguageHarness("en");
    assert.equal(h.api.t("测试"), "Test");
    h.api.setLanguage("zh");
    assert.equal(h.windowValue.localStorage.getItem("codex-plus-lang"), "zh");
    assert.equal(h.reloads(), 1);
  });

  it("存储写入失败仍能切回中文，保留路由并支持下次切换", () => {
    const h = managerLanguageHarness("en", false);
    h.api.setLanguage("zh");
    const href = h.windowValue.location.href;
    assert.equal(new URL(href).searchParams.get("view"), "settings");
    assert.equal(new URL(href).hash, "#language");
    const next = managerLanguageHarness("en", true, href);
    assert.equal(next.api.getLanguage(), "zh");
    next.api.setLanguage("en");
    assert.equal(new URL(next.windowValue.location.href).searchParams.has("xuan-language"), false);
    assert.equal(next.windowValue.localStorage.getItem("codex-plus-lang"), "en");
  });
});
