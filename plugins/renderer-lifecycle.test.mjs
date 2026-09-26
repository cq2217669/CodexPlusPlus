import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function source(name, file) {
  return fs.readFileSync(new URL(`./${name}/scripts/${file}.user.js`, import.meta.url), "utf8");
}

function extract(text, name) {
  const start = text.indexOf(`  function ${name}(`);
  const end = text.indexOf("\n  function ", start + 1);
  assert.ok(start >= 0 && end > start, name);
  return text.slice(start, end);
}

function clock() {
  let next = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout(fn) { pending.set(++next, fn); return next; },
    clearTimeout(id) { pending.delete(id); },
    async tick() {
      const tasks = [...pending.values()];
      pending.clear();
      for (const fn of tasks) await fn();
    },
  };
}

test("润色按钮状态不变时不重复改写文本，普通 Enter 不被拦截", () => {
  const text = source("xuan-polish", "polish-composer");
  let writes = 0;
  class Button {
    label = "润色";
    classList = { toggle() {} };
    setAttribute() {}
    get textContent() { return this.label; }
    set textContent(value) { this.label = value; writes++; }
  }
  const button = new Button();
  const context = vm.createContext({
    HTMLElement: Button, BUTTON_LABELS: { idle: "润色", loading: "停止" },
    currentButtonState: () => "idle", runtime: { disposed: false },
    eventTargetsComposer: () => true, isMacPlatform: () => false,
    onButtonClick: () => assert.fail("普通 Enter 不应触发润色"),
  });
  vm.runInContext([
    extract(text, "refreshButtonAppearance"),
    extract(text, "isPromptOptimizeShortcut"),
    extract(text, "onPromptOptimizeShortcut"),
  ].join("\n"), context);
  for (let i = 0; i < 100; i++) context.refreshButtonAppearance(button);
  assert.equal(writes, 0);
  context.currentButtonState = () => "loading";
  context.refreshButtonAppearance(button);
  assert.equal(writes, 1);
  context.onPromptOptimizeShortcut({ key: "Enter", preventDefault: () => assert.fail("不得吞掉 Enter") });
});

test("润色扫描不因连续流式变更无限延后，销毁后不再调度", async () => {
  const timer = clock();
  const runtime = { disposed: false, mutationTimer: 0 };
  let scans = 0;
  const context = vm.createContext({ runtime, window: timer, DEBOUNCE_MS: 400, ensureButton() { scans++; }, updateComposerObserver() {} });
  const text = source("xuan-polish", "polish-composer");
  const start = text.indexOf("  function scheduleEnsure(");
  const end = text.indexOf("  async function startObservers(", start);
  vm.runInContext(text.slice(start, end), context);
  for (let i = 0; i < 100; i++) context.scheduleEnsure();
  assert.equal(timer.pending.size, 1);
  await timer.tick();
  assert.equal(scans, 1);
  runtime.disposed = true;
  context.scheduleEnsure();
  assert.equal(timer.pending.size, 0);
});

test("搜索面板自身重绘不触发项目查询，宿主变更合并且请求保持单个", async () => {
  const timer = clock();
  class Element {
    constructor(own) { this.own = own; }
    closest() { return this.own ? this : null; }
  }
  const state = { disposed: false, chromeTimer: 0, contextTimer: 0, contextRequest: null, root: { hidden: false } };
  let calls = 0;
  let release;
  const context = vm.createContext({
    state, Element, window: timer, ROOT_ID: "search", STYLE_ID: "style", BUTTON_CLASS: "button",
    CHROME_DEBOUNCE_MS: 750,
    ensureHeaderButton() {}, watchChrome() {}, syncTheme() {}, cleanup() { state.disposed = true; },
    syncCurrentWorkspace() { calls++; return new Promise(resolve => { release = resolve; }); },
  });
  const text = source("xuan-workspace-search", "workspace-search");
  vm.runInContext(extract(text, "refreshChromeContext") + extract(text, "scheduleChromeContext"), context);
  context.scheduleChromeContext([{ target: new Element(true) }]);
  assert.equal(timer.pending.size, 0);
  for (let i = 0; i < 100; i++) context.scheduleChromeContext([{ target: new Element(false) }]);
  assert.equal(timer.pending.size, 1);
  await timer.tick();
  await timer.tick();
  assert.equal(calls, 1);
  context.refreshChromeContext();
  assert.equal(timer.pending.size, 0);
  release();
  await state.contextRequest;
  state.disposed = true;
  context.scheduleChromeContext([{ target: new Element(false) }]);
  assert.equal(timer.pending.size, 0);
});

test("手机命令卸载会清除监听和超时，取消旧请求且拒绝后续调用", async () => {
  const timer = clock();
  const listeners = new Set();
  const cleanups = [];
  const window = {
    ...timer, clearInterval() {},
    electronBridge: { sendMessageFromView() {} },
    __codexPlusUserScripts: { currentKey: "mobile", registerCleanup(fn) { cleanups.push(fn); } },
    addEventListener(_type, fn) { listeners.add(fn); },
    removeEventListener(_type, fn) { listeners.delete(fn); },
  };
  const text = source("xuan-mobile", "mobile-connect");
  const end = text.indexOf("\n(() => {", 1);
  vm.runInNewContext(text.slice(0, end), { window, crypto: { randomUUID: () => "test" } });
  const command = window.__codexPlusMobileRemoteCommand;
  const pending = command({ commandType: "stop_task", threadId: "test", turnId: "test" });
  const rejected = assert.rejects(pending, /已停用/);
  assert.equal(listeners.size, 1);
  cleanups[0]();
  await rejected;
  assert.equal(listeners.size, 0);
  assert.equal(timer.pending.size, 0);
  assert.equal(window.__codexPlusMobileRemoteCommand, undefined);
  await assert.rejects(command({ commandType: "stop_task", turnId: "test" }), /已停用/);
});

test("手机状态请求在卸载后返回不会重建定时器", async () => {
  const timer = clock();
  const state = { disposed: false, timer: 0, status: { enabled: true } };
  let release;
  const context = vm.createContext({ state, window: timer, refreshStatus: () => new Promise(resolve => { release = resolve; }) });
  context.closedRefreshMs = 30_000;
  context.openRefreshMs = 5_000;
  vm.runInContext(extract(source("xuan-mobile", "mobile-connect"), "schedule"), context);
  context.schedule();
  const tick = timer.tick();
  state.disposed = true;
  release();
  await tick;
  assert.equal(timer.pending.size, 0);
  state.disposed = false;
  state.status = { enabled: false };
  context.schedule();
  assert.equal(timer.pending.size, 0);
});

test("顶部栏延迟挂载和外壳替换后恢复局部监听", () => {
  for (const [name, file, stateful] of [
    ["xuan-usage", "usage-header", false],
    ["xuan-workspace-search", "workspace-search", true],
  ]) {
    const observers = [];
    class MutationObserver {
      targets = [];
      disconnected = false;
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target, options) { this.targets.push({ target, options }); }
      disconnect() { this.disconnected = true; }
    }
    const body = { parentElement: null };
    const shell = { parentElement: body };
    let header = null;
    let scheduled = 0;
    const fields = { observer: null, headerHostObserver: null, bootstrapObserver: null, observedHeader: null };
    const context = vm.createContext({
      ...fields, state: { ...fields }, document: { body }, MutationObserver,
      findHeader: () => header,
      scheduleEnsure: () => scheduled++, scheduleChromeWatch: () => scheduled++,
      scheduleChromeContext() {},
    });
    vm.runInContext(extract(source(name, file), "watchChrome"), context);
    context.watchChrome();
    const bootstrap = observers[0];
    assert.ok(bootstrap, `${name} 应在顶部栏缺失时等待挂载`);
    assert.equal(bootstrap.targets[0].options.subtree, true);
    context.watchChrome();
    assert.equal(observers.length, 1);
    header = { parentElement: shell };
    bootstrap.callback([]);
    assert.equal(scheduled, 1);
    context.watchChrome();
    assert.equal(bootstrap.disconnected, true);
    const active = stateful ? context.state : context;
    assert.equal(active.observer.targets[0].target, header);
    assert.ok(active.headerHostObserver.targets.some(({ target }) => target === body));
    assert.ok(active.headerHostObserver.targets.every(({ options }) => !options.subtree));
    const oldObserver = active.observer;
    header = { parentElement: { parentElement: body } };
    active.headerHostObserver.callback([]);
    context.watchChrome();
    assert.equal(oldObserver.disconnected, true);
    assert.equal(active.observer.targets[0].target, header);
  }
});

test("手机界面在自身作用域按开关状态选择刷新间隔", () => {
  const text = source("xuan-mobile", "mobile-connect");
  const start = text.indexOf("\n(() => {", 1);
  const delays = [];
  const window = {
    addEventListener() {}, clearTimeout() {},
    setTimeout(_callback, delay) { delays.push(delay); return delays.length; },
  };
  const script = text.slice(start).replace(/  render\(\);\r?\n  void refreshAll\(\);/, "  window.testState = state; window.testSchedule = schedule;");
  vm.runInNewContext(script, { window });
  window.testSchedule();
  assert.equal(delays.length, 0);
  window.testState.open = true;
  window.testSchedule();
  assert.equal(delays.at(-1), 5_000);
  window.testState.open = false;
  window.testState.status = { enabled: true };
  window.testSchedule();
  assert.equal(delays.at(-1), 30_000);
});
