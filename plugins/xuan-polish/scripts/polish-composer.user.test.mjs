import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const source = fs.readFileSync(path.join(import.meta.dirname, "polish-composer.user.js"), "utf8");
const routes = [
  ["/prompt-optimize/settings", "/v1/polish/settings", "GET"],
  ["/prompt-optimize/generate", "/v1/polish", "POST"],
  ["/settings/set", "/v1/polish/settings/set", "POST"],
];

function adapter(pageBridge) {
  const timers = new Map();
  const delays = new Map();
  const context = vm.createContext({
    window: {
      __xuanPluginBridge: { "xuan-polish": pageBridge },
      setTimeout(callback, delay) { timers.set(1, callback); delays.set(1, delay); return 1; },
      clearTimeout(id) { timers.delete(id); delays.delete(id); },
    },
    BRIDGE_KEY: "__xuanPluginBridge",
    SETTINGS_BRIDGE_TIMEOUT_MS: 40000,
    GENERATE_BRIDGE_TIMEOUT_MS: 135000,
  });
  const start = source.indexOf("  function bridgeCall(");
  const end = source.indexOf("  async function refreshSettings()", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  return { call: context.bridgeCall, timers, delays };
}

function functionSource(name) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf("\n  function ", start + 1);
  assert.ok(start >= 0 && end > start, `未找到 ${name}`);
  return source.slice(start, end);
}

function composerAnchorAdapter() {
  class ComposerElement {
    constructor(tagName, { attributes = {}, textContent = "", className = "" } = {}) {
      this.tagName = tagName;
      this.attributes = new Map(Object.entries(attributes));
      this.textContent = textContent;
      this.className = className;
      this.children = [];
      this.parentElement = null;
      this.parentNode = null;
    }

    append(child) {
      child.parentElement = this;
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    get nextSibling() {
      const siblings = this.parentElement?.children || [];
      return siblings[siblings.indexOf(this) + 1] || null;
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    hasAttribute(name) {
      return this.attributes.has(name);
    }

    matches(selector) {
      return selector === ".composer-footer" && this.className.split(/\s+/).includes("composer-footer");
    }

    closest(selector) {
      let node = this;
      while (node) {
        if (node.matches?.(selector)) return node;
        node = node.parentElement;
      }
      return null;
    }

    contains(node) {
      return this === node || this.children.some((child) => child.contains(node));
    }

    querySelectorAll() {
      const descendants = [];
      const visit = (node) => {
        for (const child of node.children) {
          descendants.push(child);
          visit(child);
        }
      };
      visit(this);
      return descendants.filter((node) => node.tagName === "BUTTON" || node.getAttribute("role") === "button");
    }

    getBoundingClientRect() {
      return { width: 24, height: 24, top: 0, bottom: 24, left: 0, right: 24 };
    }
  }

  const document = { body: new ComposerElement("BODY") };
  document.querySelectorAll = (selector) => {
    const nodes = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches?.(selector)) nodes.push(child);
        visit(child);
      }
    };
    visit(document.body);
    return nodes;
  };
  const context = vm.createContext({
    BUTTON_ATTR: "data-cpo-button-test",
    HTMLElement: ComposerElement,
    Element: ComposerElement,
    document,
    window: {
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", fontSize: "12px" }),
    },
  });
  const functions = [
    "collapseWs",
    "normalizeText",
    "isVisible",
    "isSendLikeLabel",
    "isAccessPermissionLikeLabel",
    "accessPermissionBeforeSend",
    "controlAfterAnchor",
    "composerFooterForInput",
    "composerInsertAnchor",
  ];
  vm.runInContext(functions.map(functionSource).join("\n"), context);
  return { ComposerElement, document, composerInsertAnchor: context.composerInsertAnchor };
}

function buttonAppearanceAdapter() {
  class Button {
    constructor() {
      this.attributes = new Map();
      this.classList = {
        values: new Set(),
        toggle: (name, enabled) => {
          if (enabled) this.classList.values.add(name);
          else this.classList.values.delete(name);
        },
      };
      this.disabled = true;
      this.textContent = "";
      this.title = "";
    }

    setAttribute(name, value) {
      this.attributes.set(name, value);
    }
  }

  const runtime = { loading: false };
  const buttons = [new Button(), new Button()];
  const context = vm.createContext({
    runtime,
    BUTTON_ATTR: "data-cpo-button-test",
    BUTTON_LABELS: { idle: "润色", loading: "停止", restore: "恢复" },
    HTMLElement: Button,
    document: { querySelectorAll: () => buttons },
    getThreadState: () => ({ mode: "idle" }),
  });
  vm.runInContext([
    functionSource("currentButtonState"),
    functionSource("refreshButtonAppearance"),
  ].join("\n"), context);
  return { runtime, buttons, refresh: context.refreshButtonAppearance };
}

function optimizeAdapter(generate) {
  const toasts = [];
  const calls = [];
  const state = { mode: "idle", originalText: null, optimizedText: null };
  const input = {};
  const runtime = {
    disposed: false,
    loading: false,
    optimizeToken: 0,
    optimizePhase: "idle",
    pendingGenerateToken: 0,
    optimizeDeadlineAt: 0,
    retryBlockedUntil: 0,
    lastOptimizeError: "",
    settings: null,
    settingsRequest: null,
    bridgeError: "",
  };
  const settings = {
    baseUrlConfigured: true,
    apiKeyConfigured: true,
    model: "test-model",
    style: "structured",
    timeoutMs: 60000,
  };
  runtime.settings = settings;
  const context = vm.createContext({
    runtime,
    GENERATE_SETTLE_GRACE_MS: 5000,
    Date,
    Promise,
    Number,
    Math,
    String,
    refreshButtonAppearance() {},
    showToast(message, kind) { toasts.push({ message, kind }); },
    async refreshSettings() { runtime.settings = settings; runtime.bridgeError = ""; return settings; },
    isConfigured: () => true,
    openSettingsPanel() {},
    findComposerInput: () => input,
    normalizeText: (value) => String(value || "").trim(),
    readComposerText: () => "草稿",
    getThreadState: () => state,
    collectRecentConversationTurns: () => [],
    currentSessionId: () => "test-thread",
    promptOptimizeContext: { shouldIncludeProjectMap: () => false },
    promptOptimizeState: {
      saveSnapshotIfApplied(actual, originalText, optimizedText, applied) {
        if (!applied) return false;
        actual.mode = "optimized";
        actual.originalText = originalText;
        actual.optimizedText = optimizedText;
        return true;
      },
    },
    async bridgeCall(path, payload) {
      calls.push({ path, payload });
      return path === "/prompt-optimize/generate"
        ? generate()
        : { status: "ok", settings };
    },
    writeComposerTextWithFallback: async () => ({ ok: true, clipboard: false }),
    runRestore() {},
  });
  const optimizeStart = source.indexOf("  function retryWaitMessage()");
  const optimizeEnd = source.indexOf("\n  async function runRestore()", optimizeStart);
  const clickStart = source.indexOf("  function onButtonClick(", optimizeEnd);
  const clickEnd = source.indexOf("\n  function onButtonContextMenu(", clickStart);
  assert.ok(optimizeStart >= 0 && optimizeEnd > optimizeStart && clickStart > optimizeEnd && clickEnd > clickStart);
  vm.runInContext(`${source.slice(optimizeStart, optimizeEnd)}\n${source.slice(clickStart, clickEnd)}`, context);
  return {
    calls,
    runtime,
    toasts,
    cancel: context.cancelOptimize,
    click: context.onButtonClick,
    run: context.runOptimize,
  };
}

test("润色按钮已经紧邻权限控件时不再次插入自身", () => {
  class Element {
    isConnected = true;
    hasAttribute() { return true; }
  }
  const input = new Element();
  const parent = new Element();
  const host = new Element();
  const button = new Element();
  let moves = 0;
  parent.insertBefore = () => { moves++; };
  host.parentElement = parent;
  host.parentNode = parent;
  host.nextSibling = new Element();
  button.parentElement = host;
  const context = vm.createContext({
    Element, HTMLElement: Element, runtime: { disposed: false },
    BUTTON_ATTR: "test", INSTANCE_REVISION: "test",
    findComposerInput: () => input,
    document: { querySelector: () => button },
    composerInsertAnchor: () => ({ node: parent, before: host }),
    refreshButtonAppearance() {},
  });
  vm.runInContext(functionSource("ensureButton"), context);
  for (let i = 0; i < 100; i++) context.ensureButton();
  assert.equal(moves, 0);
});

test("polish script keeps the original composer workflow in an independent bridge adapter", () => {
  assert.match(source, /MutationObserver/);
  assert.match(source, /\/v1\/polish/);
  assert.match(source, /停止/);
  assert.match(source, /恢复/);
  assert.match(source, /Ctrl\+Enter|ctrlKey/);
  assert.match(source, /润色中|正在润色|loading/);
});

test("polish script keeps Ctrl+Enter as a toggle shortcut", () => {
  assert.match(source, /if \(event\.ctrlKey && !event\.metaKey\) return true;/);
  assert.match(source, /const activeElement = document\.activeElement;/);
  assert.match(source, /function onPromptOptimizeShortcut\(event\) \{\s*if \(runtime\.disposed\) return;/);
});

test("设置桥接延迟时不销毁润色按钮", () => {
  const start = source.indexOf("  async function startObservers()");
  const end = source.indexOf("\n  function ensure()", start);
  const observerSource = source.slice(start, end);
  assert.match(observerSource, /installStyle\(\);\s*ensureButton\(\);\s*void refreshSettings\(\)\.then/);
  assert.doesNotMatch(observerSource, /await refreshSettings\(\)/);
  assert.doesNotMatch(observerSource, /destroyAll\(\)/);

  const optimizeStart = source.indexOf("  async function runOptimize()");
  const optimizeEnd = source.indexOf("\n  function cancelOptimize()", optimizeStart);
  const optimizeSource = source.slice(optimizeStart, optimizeEnd);
  assert.match(optimizeSource, /if \(!settings \|\| !isConfigured\(settings\)\)/);
  assert.doesNotMatch(optimizeSource, /await refreshSettings\(\)/);
});

test("润色失败后可立即重试，并给出可观察的重试反馈", async () => {
  const fixture = optimizeAdapter(async () => ({ status: "failed", error: "服务暂不可用" }));
  await fixture.run();
  assert.equal(fixture.runtime.loading, false);
  assert.equal(fixture.calls.filter((call) => call.path === "/prompt-optimize/generate").length, 1);
  assert.equal(fixture.toasts.at(-1).message, "服务暂不可用");

  await fixture.run();
  assert.equal(fixture.calls.filter((call) => call.path === "/prompt-optimize/generate").length, 2);
  assert.ok(fixture.toasts.some((toast) => toast.message === "正在重试润色，请稍候"));
  assert.equal(fixture.toasts.at(-1).message, "重试失败：服务暂不可用");
});

test("润色和重试进行中时，所有已挂载按钮都显示停止", () => {
  const fixture = buttonAppearanceAdapter();
  fixture.runtime.loading = true;
  fixture.refresh();
  for (const button of fixture.buttons) {
    assert.equal(button.textContent, "停止");
    assert.equal(button.attributes.get("aria-busy"), "true");
    assert.equal(button.classList.values.has("cpo-loading"), true);
  }
});

test("主动停止后若底层请求仍在结束，再次点击会显示等待提示", async () => {
  let finishGenerate;
  const fixture = optimizeAdapter(() => new Promise((resolve) => { finishGenerate = resolve; }));
  const pending = fixture.run();
  while (!finishGenerate) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.cancel(), true);
  const generateCalls = fixture.calls.filter((call) => call.path === "/prompt-optimize/generate").length;
  fixture.click({ preventDefault() {}, stopPropagation() {} });
  assert.equal(fixture.calls.filter((call) => call.path === "/prompt-optimize/generate").length, generateCalls);
  assert.match(fixture.toasts.at(-1).message, /仍在后台结束.*秒内可再次润色/);

  finishGenerate({ status: "failed", error: "请求已结束" });
  await pending;
  assert.equal(fixture.runtime.retryBlockedUntil, 0);
});

test("输入框重绘先恢复权限控件时，润色按钮仍可定位", () => {
  const { ComposerElement, document, composerInsertAnchor } = composerAnchorAdapter();
  const composer = document.body.append(new ComposerElement("DIV"));
  const input = composer.append(new ComposerElement("DIV", { attributes: { role: "textbox" } }));
  const permission = composer.append(new ComposerElement("BUTTON", { attributes: { "aria-label": "完全访问" } }));

  const anchorWithoutSend = composerInsertAnchor(input);
  assert.equal(anchorWithoutSend.node, composer);
  assert.equal(anchorWithoutSend.before, null);

  const send = composer.append(new ComposerElement("BUTTON", { attributes: { "aria-label": "Send message" } }));
  const anchorWithSend = composerInsertAnchor(input);
  assert.equal(anchorWithSend.node, composer);
  assert.equal(anchorWithSend.before, send);
  assert.equal(permission.nextSibling, send);
});

test("优先使用 composer footer，输入框与权限控件不在同一层时仍插入到完全访问右侧", () => {
  const { ComposerElement, document, composerInsertAnchor } = composerAnchorAdapter();
  const form = document.body.append(new ComposerElement("FORM"));
  const input = form.append(new ComposerElement("DIV", { attributes: { role: "textbox" } }));
  const footer = form.append(new ComposerElement("DIV", { className: "composer-footer" }));
  const permission = footer.append(new ComposerElement("BUTTON", { attributes: { "aria-label": "Full access" } }));
  const anchor = composerInsertAnchor(input);
  assert.equal(anchor.node, footer);
  assert.equal(anchor.before, null);
  assert.equal(permission.nextSibling, null);
});

test("polish script supports cancellation, restore state and settings without exposing credentials", () => {
  assert.match(source, /optimizeToken|AbortController/);
  assert.match(source, /promptOptimizeState/);
  assert.match(source, /\/v1\/polish\/settings/);
  assert.doesNotMatch(source, /Authorization\s*:/i);
  assert.doesNotMatch(source, /bearer\s+\$?\{/i);
});

test("润色设置可选择已配置供应商及其模型", () => {
  assert.match(source, /<label>供应商<\/label>/);
  assert.match(source, /data-cpo="modelSelect"/);
  assert.match(source, /function providerModelOptions\(/);
  assert.match(source, /function setProviderModelOptions\(/);
  assert.match(source, /provider\.defaultModel/);
  assert.match(source, /data-cpo-manual/);
});

test("润色设置打开后后台刷新，不等待桥接返回", () => {
  const start = source.indexOf("  function openSettingsPanel(");
  const end = source.indexOf("\n  async function saveSettingsFromPanel", start);
  const panelSource = source.slice(start, end);
  assert.match(panelSource, /document\.documentElement\.appendChild\(overlay\);\s*if \(refresh\) \{\s*void refreshSettings\(\)\.then/);
  assert.doesNotMatch(panelSource, /await refreshSettings\(\)/);
  assert.match(source, /if \(runtime\.settingsRequest\) return runtime\.settingsRequest;/);
});

test("润色设置只提交插件原生字段", () => {
  const start = source.indexOf("  async function saveSettingsFromPanel(");
  const end = source.indexOf("\n  function scheduleEnsure()", start);
  const saveSource = source.slice(start, end);
  assert.match(saveSource, /const model = \(relayIdEl\.value \? modelSelectEl\.value : modelInputEl\.value\)\.trim\(\);/);
  assert.match(saveSource, /const next = \{\s*relayId: relayIdEl\.value,\s*style: styleEl\.value,\s*model,/);
  assert.match(saveSource, /next\.protocol =/);
  assert.match(saveSource, /next\.baseUrl = baseUrl/);
  assert.match(saveSource, /next\.apiKey = apiKey/);
});

test("润色三个接口都通过页面桥接且原样转发参数", async () => {
  const calls = [];
  const result = { status: "ok", settings: {}, text: "修改后的文本" };
  const { call, timers } = adapter((path, payload) => {
    calls.push({ path, payload });
    return Promise.resolve(result);
  });
  for (const [path, route] of routes) {
    const payload = { text: "草稿" };
    assert.equal(await call(path, payload), result);
    assert.deepEqual(calls.at(-1), { path: route, payload });
    assert.equal(timers.size, 0);
  }
});

test("润色插件未连接时返回可读错误", async () => {
  const { call } = adapter(undefined);
  for (const [path] of routes) {
    const result = await call(path, { text: "草稿" });
    assert.equal(result.status, "failed");
    assert.match(result.message, /插件尚未连接/);
    assert.doesNotMatch(result.message, /启动器/);
  }
});

test("润色页面桥接失败不回退重发，并展示中文错误", async () => {
  for (const bridge of [
    () => Promise.reject(new Error("networkerror")),
    () => ({ status: "failed", message: "Unknown bridge path" }),
    () => ({ status: "failed", error: { message: "服务暂不可用" } }),
  ]) {
    const { call, timers } = adapter(bridge);
    const result = await call("/settings/set", { model: "test-model" });
    assert.equal(result.status, "failed");
    assert.equal(result.error, result.message);
    assert.match(result.message, /\p{Script=Han}/u);
    assert.doesNotMatch(result.message, /networkerror|\[object Object\]/);
    assert.equal(timers.size, 0);
  }
});

test("润色业务失败及页面桥接超时均有可读结果并清除计时器", async () => {
  const { call } = adapter(async () => ({ status: "failed", error: { message: "当前配置不可用" } }));
  assert.equal((await call("/prompt-optimize/settings", {})).error, "当前配置不可用");
  const stalled = adapter(() => new Promise(() => {}));
  const pending = stalled.call("/prompt-optimize/generate", { text: "草稿" });
  assert.equal(stalled.delays.get(1), 135000);
  stalled.timers.get(1)();
  assert.match((await pending).error, /超时/);
  assert.equal(stalled.timers.size, 0);

  const stalledSettings = adapter(() => new Promise(() => {}));
  const settingsPending = stalledSettings.call("/prompt-optimize/settings", {});
  assert.equal(stalledSettings.delays.get(1), 40000);
  stalledSettings.timers.get(1)();
  assert.match((await settingsPending).error, /读取润色设置超时/);
});
