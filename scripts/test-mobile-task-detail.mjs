import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "apps/codex-plus-manager/package.json"));
const ts = require("typescript");
const ets = path.join(root, "apps/xuan-plus-remote/app/entry/src/main/ets");
const source = await readFile(path.join(ets, "pages/Index.ets"), "utf8");
const start = source.indexOf("struct Index {");
const end = source.indexOf("  @Builder", start);
assert.ok(start >= 0 && end > start, "必须直接测试实际详情页面的方法");

function compile(text) {
  const result = ts.transpileModule(text, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true,
      useDefineForClassFields: false,
    },
    reportDiagnostics: true,
  });
  assert.equal(result.diagnostics?.length ?? 0, 0);
  return result.outputText;
}

const modelContext = vm.createContext({ exports: {} });
vm.runInContext(compile(await readFile(path.join(ets, "remote/RemoteModels.ets"), "utf8")), modelContext);
const pageCode = compile(`${source.slice(start, end).replace("struct Index", "class Index")}}\nglobalThis.Index = Index;`);
const lifecycleCode = compile(await readFile(path.join(ets, "remote/AppLifecycleCoordinator.ets"), "utf8"));
const checks = [];

function snapshot(version = 1, text = "第一轮回复", overrides = {}) {
  return {
    remoteTaskId: "fixture_task_0001", pcDeviceId: "fixture_pc_000001",
    installationId: "fixture_install_0001", bindingEpoch: 1,
    name: "测试任务", workspaceName: "测试工作区", modelLabel: "测试模型",
    taskStatus: "stopped", turnStatus: "completed", lastTurnOutcome: "completed",
    stateVersion: version, lastReplyVersion: version, lastReplyState: "available",
    lastReply: { state: "available", text, byteLength: Buffer.byteLength(text), truncated: false },
    pcObservedAt: "2026-09-06T00:00:00Z", serverReceivedAt: "2026-09-06T00:00:00Z",
    pcConnectionState: "online", lastError: null, ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  const timers = new Map();
  let timerId = 0;
  let detailCalls = 0;
  let listCalls = 0;
  let latest = snapshot();
  let stream;
  const context = vm.createContext({
    ...modelContext.exports,
    exports: {},
    State() {},
    StorageLink: () => () => {},
    DOMAIN: 0, TAG: "test", TASK_REFRESH_INTERVAL_MS: 30000,
    KeyboardAvoidMode: { RESIZE: 1 },
    Edge: { Bottom: 1 },
    ScrollState: { Idle: 0, Scroll: 1, Fling: 2 },
    Scroller: class {
      atEnd = true;
      scrolls = 0;
      isAtEnd() { return this.atEnd; }
      scrollEdge() { this.scrolls++; }
    },
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    hilog: { warn() {}, info() {} },
    PushNotificationCoordinator: {
      retryPendingRefresh() {}, setRefreshHandler() {},
      setNotificationPermissionHandler() {},
    },
    LiveReplyStreamCoordinator: {
      disconnect() {},
      async connect(_registration, _task, update, end, status) {
        stream = { update, end, status };
        status(true, "正在同步");
      },
    },
    TaskSyncCoordinator: {
      async getTask() {
        detailCalls++;
        return { snapshot: latest, serverReceivedAt: latest.serverReceivedAt };
      },
      async listTasks() {
        listCalls++;
        return { tasks: [latest], nextCursor: null, serverReceivedAt: latest.serverReceivedAt };
      },
    },
    RemoteApiClient: {
      describeFailure: () => ({ title: "请求暂不可用", reason: "测试失败", retryable: true }),
    },
    RemoteCommandCoordinator: {
      resultFailure: () => undefined,
      resultNotice: () => "消息已完成",
    },
  });
  vm.runInContext(lifecycleCode, context);
  context.AppLifecycleCoordinator = context.exports.AppLifecycleCoordinator;
  context.AppLifecycleCoordinator.setForeground(true);
  vm.runInContext(pageCode, context);
  const page = new context.Index();
  page.getUIContext = () => ({
    getKeyboardAvoidMode: () => 0,
    setKeyboardAvoidMode() {},
  });
  page.deviceRegistration = { appDeviceId: "fixture_phone_0001", deviceKeyId: "fixture_key_000001" };
  page.activePcDevice = {
    pcDeviceId: latest.pcDeviceId, installationId: latest.installationId,
    bindingEpoch: 1, pcConnectionState: "online",
  };
  page.connectionState = "online";
  page.pairingState = "active";
  page.tasks = [latest];
  page.selectedTaskId = latest.remoteTaskId;
  page.activePage = "detail";
  return {
    page, context, timers,
    setLatest(value) { latest = value; },
    get detailCalls() { return detailCalls; },
    get listCalls() { return listCalls; },
    get stream() { return stream; },
  };
}

async function test(name, run) {
  await run();
  checks.push(name);
}

await test("详情低频补拉兜底，不产生高频列表轮询", async () => {
  const env = setup();
  env.setLatest(snapshot(2, "第一轮回复\n\n---\n\n第二轮回复"));
  await env.page.runTaskSync(env.page.taskSyncGeneration);
  assert.equal(env.detailCalls, 1);
  assert.equal(env.listCalls, 0);
  assert.equal(env.page.selectedTask().stateVersion, 2);
  assert.equal(env.timers.size, 1);
  assert.equal([...env.timers.values()][0].delay, 30000);
  env.page.stopTaskSyncLoop();
  assert.equal(env.timers.size, 0);
});

await test("打开详情立即同步且保留草稿", async () => {
  const env = setup();
  env.page.instruction = "待发送的中文消息";
  env.page.openTaskDetail(env.page.tasks[0]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.detailCalls, 2);
  assert.equal(env.page.instruction, "待发送的中文消息");
});

await test("同一详情请求不重叠，旧快照不能覆盖新版本", async () => {
  const env = setup();
  const pending = deferred();
  env.context.TaskSyncCoordinator.getTask = () => pending.promise;
  const refresh = env.page.refreshSelectedTask(env.page.selectedTaskId);
  await env.page.refreshSelectedTask(env.page.selectedTaskId);
  assert.equal(env.page.refreshingSelectedTask, true);
  env.page.tasks = [snapshot(3, "新回复")];
  pending.resolve({ snapshot: snapshot(2), serverReceivedAt: snapshot().serverReceivedAt });
  await refresh;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.page.selectedTask().stateVersion, 3);
  assert.equal(env.page.refreshingSelectedTask, false);
});

await test("退出并重进详情后丢弃旧请求", async () => {
  const env = setup();
  const pending = deferred();
  env.context.TaskSyncCoordinator.getTask = () => pending.promise;
  const refresh = env.page.refreshSelectedTask(env.page.selectedTaskId);
  env.page.leaveTaskDetail();
  env.context.TaskSyncCoordinator.getTask = async () => ({ snapshot: snapshot() });
  env.page.openTaskDetail(env.page.tasks[0]);
  pending.resolve({ snapshot: snapshot(9, "过期请求"), serverReceivedAt: snapshot().serverReceivedAt });
  await refresh;
  assert.equal(env.page.selectedTask().stateVersion, 1);
});

await test("切换绑定和进入后台后不应用在途响应", async () => {
  for (const invalidate of [
    env => env.page.taskVisibilityGeneration++,
    env => env.context.AppLifecycleCoordinator.setForeground(false),
  ]) {
    const env = setup();
    const pending = deferred();
    env.context.TaskSyncCoordinator.getTask = () => pending.promise;
    const refresh = env.page.refreshSelectedTask(env.page.selectedTaskId);
    invalidate(env);
    pending.resolve({ snapshot: snapshot(9), serverReceivedAt: snapshot().serverReceivedAt });
    await refresh;
    assert.equal(env.page.selectedTask().stateVersion, 1);
  }
});

await test("失败自动重试，后台停止轮询", async () => {
  const env = setup();
  env.context.TaskSyncCoordinator.getTask = async () => { throw new Error("测试网络异常"); };
  await env.page.runTaskSync(env.page.taskSyncGeneration);
  assert.match(env.page.liveReplyNotice, /自动重试/);
  assert.equal(env.timers.size, 1);
  env.page.stopTaskSyncLoop();
  env.context.AppLifecycleCoordinator.setForeground(false);
  await env.page.runTaskSync(env.page.taskSyncGeneration);
  assert.equal(env.timers.size, 0);
});

await test("最终快照延迟超过旧重试窗口后仍能自动校准", async () => {
  const env = setup();
  const history = "第一轮回复\n\n---\n\n第二轮回复";
  env.page.startLiveReplyStream();
  env.stream.update({ text: history, observedAt: "2026-09-06T00:00:00Z" });
  env.stream.end("completed");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.page.liveReplyAwaitingFinalSnapshot, true);
  for (let attempt = 0; attempt < 5; attempt++) {
    await env.page.runTaskSync(env.page.taskSyncGeneration);
    env.page.stopTaskSyncLoop();
  }
  assert.equal(env.page.detailReplyText(env.page.selectedTask()), history);
  env.setLatest(snapshot(2, history));
  await env.page.refreshSelectedTask(env.page.selectedTaskId);
  assert.equal(env.page.liveReplyAwaitingFinalSnapshot, false);
  assert.equal(env.page.liveReplyText, "");
  assert.equal(env.page.detailReplyText(env.page.selectedTask()), history);
});

await test("订阅已完成任务不要求回复版本再次变化", async () => {
  const env = setup();
  env.page.startLiveReplyStream();
  env.stream.update({ text: "第一轮回复", observedAt: "2026-09-06T00:00:00Z" });
  env.stream.end("completed");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.page.liveReplyAwaitingFinalSnapshot, false);
});

await test("展示优先完整快照，安全隐藏状态不展示实时内容", async () => {
  const env = setup();
  env.page.liveReplyActive = true;
  env.page.liveReplyText = "第一轮";
  assert.equal(env.page.detailReplyText(env.page.selectedTask()), "第一轮回复");
  env.page.tasks = [snapshot(2, "", { lastReplyState: "withheld", lastReply: null })];
  assert.equal(env.page.detailReplyText(env.page.selectedTask()), "");
});

await test("列表刷新保留分页中的当前任务和更高版本", async () => {
  const env = setup();
  env.page.tasks = [snapshot(3, "最新回复")];
  await env.page.refreshTasks(false);
  assert.equal(env.page.selectedTask().stateVersion, 3);
  env.context.TaskSyncCoordinator.listTasks = async () => ({
    tasks: [snapshot(1, "其他任务", { remoteTaskId: "fixture_task_0002" })],
    nextCursor: "next", serverReceivedAt: snapshot().serverReceivedAt,
  });
  await env.page.refreshTasks(false);
  assert.equal(env.page.activePage, "detail");
  assert.equal(env.page.selectedTask().stateVersion, 3);
});

await test("详情同步期间消息仍能提交，刷新不提前释放发送锁", async () => {
  const env = setup();
  const pendingDetail = deferred();
  const pendingCommand = deferred();
  let submitted = 0;
  env.context.TaskSyncCoordinator.getTask = () => pendingDetail.promise;
  env.context.RemoteCommandCoordinator.submitText = async (_registration, task, text) => {
    submitted++;
    assert.equal(task.remoteTaskId, env.page.selectedTaskId);
    assert.equal(text, "继续处理");
    return { status: "accepted" };
  };
  env.context.RemoteCommandCoordinator.waitForTerminal = () => pendingCommand.promise;
  env.page.instruction = "继续处理";
  const refresh = env.page.refreshSelectedTask(env.page.selectedTaskId);
  assert.equal(env.page.canSendSelected(), true);
  const sending = env.page.sendInstruction();
  assert.equal(submitted, 1);
  assert.equal(env.page.commandSubmitting, true);
  pendingDetail.resolve({ snapshot: snapshot(2), serverReceivedAt: snapshot().serverReceivedAt });
  await refresh;
  assert.equal(env.page.commandSubmitting, true);
  assert.equal(env.page.instruction, "继续处理");
  pendingCommand.resolve({ status: "completed" });
  await sending;
  assert.equal(env.page.commandSubmitting, false);
  assert.equal(env.page.instruction, "");
});

await test("发送失败保留输入且可重试", async () => {
  const env = setup();
  env.page.instruction = "保留草稿";
  env.context.RemoteCommandCoordinator.submitText = async () => { throw new Error("测试失败"); };
  await env.page.sendInstruction();
  assert.equal(env.page.instruction, "保留草稿");
  assert.equal(env.page.commandSubmitting, false);
  assert.equal(env.page.canSendSelected(), true);
});

await test("详情已删除时自动复核列表并退出失效任务", async () => {
  const env = setup();
  env.context.TaskSyncCoordinator.getTask = async () => { throw new Error("测试任务已移除"); };
  env.context.TaskSyncCoordinator.listTasks = async () => ({
    tasks: [], nextCursor: null, serverReceivedAt: snapshot().serverReceivedAt,
  });
  await env.page.refreshSelectedTask(env.page.selectedTaskId);
  assert.equal(env.page.activePage, "home");
  assert.equal(env.page.tasks.length, 0);
  assert.equal(env.page.canSendSelected(), false);
});

await test("生命周期前后台切换及卸载清理所有订阅和定时器", async () => {
  const env = setup();
  env.page.registerDevice = async () => {};
  env.page.refreshBindingStatus = async () => {};
  env.page.aboutToAppear();
  env.page.startTaskSyncLoop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.timers.size, 1);
  env.context.AppLifecycleCoordinator.setForeground(false);
  assert.equal(env.timers.size, 0);
  env.context.AppLifecycleCoordinator.setForeground(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.timers.size, 1);
  env.page.aboutToDisappear();
  assert.equal(env.timers.size, 0);
});

await test("新回复经订阅到达并增量呈现，不等待最终快照", async () => {
  const env = setup();
  env.page.startLiveReplyStream();
  const observedAt = "2026-09-06T00:00:01Z";
  const history = "第一轮回复\n\n---\n\n";
  env.stream.update({ text: `${history}正在`, observedAt });
  const flush = () => {
    const [id, timer] = [...env.timers].find(([, value]) => value.delay === 100);
    env.timers.delete(id);
    timer.callback();
  };
  flush();
  assert.equal(env.page.detailReplyText(env.page.selectedTask()), `${history}正在`);
  env.stream.update({ text: `${history}正在生成完整回复`, observedAt });
  flush();
  assert.equal(env.page.detailReplyText(env.page.selectedTask()), `${history}正在生成完整回复`);
});

await test("断线保留可见回复，退避重连补拉完整历史且不重复订阅", async () => {
  const env = setup();
  env.page.startLiveReplyStream();
  const text = "第一轮回复\n\n---\n\n" + "后续完整回复".repeat(50000);
  env.stream.update({ text, observedAt: "2026-09-06T00:00:01Z" });
  env.stream.status(false, "测试断线");
  env.stream.status(false, "重复断线通知");
  assert.equal([...env.timers.values()].filter(timer => timer.delay === 1000).length, 1);
  env.setLatest(snapshot(3, text));
  const [id, reconnect] = [...env.timers].find(([, timer]) => timer.delay === 1000);
  env.timers.delete(id);
  reconnect.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.page.detailReplyText(env.page.selectedTask()), text);
  assert.equal([...env.timers.values()].filter(timer => timer.delay === 1000).length, 0);
  env.page.leaveTaskDetail();
  assert.equal(env.timers.size, 0);
});

await test("离开再进入同一任务后旧订阅和旧请求不能影响新页面", async () => {
  const env = setup();
  env.page.startLiveReplyStream();
  const oldStream = env.stream;
  env.page.leaveTaskDetail();
  env.page.openTaskDetail(env.page.tasks[0]);
  oldStream.update({ text: "旧订阅内容", observedAt: "2026-09-06T00:00:09Z" });
  oldStream.status(false, "旧错误");
  oldStream.end("completed");
  assert.equal(env.page.pendingLiveReplyText, "");
  assert.notEqual(env.page.liveReplyNotice, "旧错误");
  assert.equal([...env.timers.values()].filter(timer => timer.delay === 1000).length, 0);
});

await test("页面卸载丢弃在途详情响应且不补拉列表", async () => {
  const env = setup();
  const pending = deferred();
  env.context.TaskSyncCoordinator.getTask = () => pending.promise;
  const refresh = env.page.refreshSelectedTask(env.page.selectedTaskId);
  env.page.aboutToDisappear();
  pending.reject(new Error("迟到网络错误"));
  await refresh;
  assert.equal(env.listCalls, 0);
  assert.equal(env.timers.size, 0);
});

await test("底部跟随增量内容，向上阅读取消跟随，回到底部后恢复", async () => {
  const env = setup();
  env.page.followReplyBottom();
  env.page.followReplyBottom();
  assert.equal(env.timers.size, 1);
  env.page.replyScroller.atEnd = false;
  env.page.trackReplyScroll(-10, env.context.ScrollState.Scroll);
  assert.equal(env.timers.size, 0);
  env.page.followReplyBottom();
  assert.equal(env.timers.size, 0);
  env.page.replyScroller.atEnd = true;
  env.page.trackReplyScroll(10, env.context.ScrollState.Fling);
  env.page.followReplyBottom();
  const [id, timer] = [...env.timers][0];
  env.timers.delete(id);
  timer.callback();
  assert.equal(env.page.replyScroller.scrolls, 1);
});

await test("发送失败后重试沿用任务标识和草稿，成功后才清空", async () => {
  const env = setup();
  const draft = "保留原始草稿\n继续执行";
  env.page.instruction = draft;
  let attempts = 0;
  env.context.RemoteCommandCoordinator.submitText = async (registration, task, text) => {
    assert.equal(registration, env.page.deviceRegistration);
    assert.equal(task.remoteTaskId, "fixture_task_0001");
    assert.equal(text, draft);
    if (++attempts === 1) throw new Error("模拟失败");
    return { status: "accepted" };
  };
  env.context.RemoteCommandCoordinator.waitForTerminal = async () => ({ status: "completed" });
  await env.page.sendInstruction();
  assert.equal(env.page.instruction, draft);
  await env.page.sendInstruction();
  assert.equal(attempts, 2);
  assert.equal(env.page.instruction, "");
});

assert.match(source, /Scroll\(this\.replyScroller\)/);
assert.match(source, /setKeyboardAvoidMode\(KeyboardAvoidMode\.RESIZE\)/);
assert.match(source, /scrollable\(this\.activePage === 'detail' \? ScrollDirection\.None/);

const streamCode = compile(await readFile(path.join(ets, "remote/LiveReplyStreamCoordinator.ets"), "utf8"));
function streamSetup(signing, open = true) {
  const sockets = [];
  const timers = new Map();
  let timerId = 0;
  const updates = [];
  const statuses = [];
  const ends = [];
  const context = vm.createContext({
    exports: {},
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    require(name) {
      if (name === "@kit.NetworkKit") return { webSocket: { createWebSocket() {
        const handlers = new Map();
        const socket = {
          handlers, closed: false,
          on(name, callback) { handlers.set(name, callback); },
          off(name) { handlers.delete(name); },
          async close() { this.closed = true; },
          async connect() { if (open) handlers.get("open")?.({ code: 0 }); },
          frame(frame) { handlers.get("message")?.({ code: 0 }, JSON.stringify(frame)); },
        };
        sockets.push(socket);
        return socket;
      } } };
      if (name === "@kit.PerformanceAnalysisKit") return { hilog: { info() {} } };
      if (name === "./RemoteApiClient") return { RemoteApiClient: {
        randomOpaqueId: () => "fixture_request_0001",
        signedGetHeaders: signing ?? (async () => ({})),
      } };
      if (name === "./RemoteEnvironmentConfig") return { RemoteEnvironmentConfig: {
        environment: "dev", replyStreamWssBaseUrl: "wss://fixture.invalid/v1/tasks",
      } };
      if (name === "./RemoteModels") return { utf8ByteLength: value => Buffer.byteLength(value) };
      throw new Error(`未模拟依赖：${name}`);
    },
  });
  vm.runInContext(streamCode, context);
  const coordinator = context.exports.LiveReplyStreamCoordinator;
  return { sockets, timers, updates, statuses, ends, coordinator,
    connect: () => coordinator.connect(
      { appDeviceId: "fixture_phone_0001", deviceKeyId: "fixture_key_000001" }, snapshot(),
      value => updates.push(value), outcome => ends.push(outcome),
      (connected, notice) => statuses.push({ connected, notice })),
  };
}
function frame(seq, messageType, text, overrides = {}) {
  return {
    schemaVersion: "1.5", messageType, messageId: `fixture_frame_${String(seq).padStart(4, "0")}`,
    environment: "dev", pcDeviceId: "fixture_pc_000001", installationId: "fixture_install_0001",
    bindingEpoch: 1, remoteTaskId: "fixture_task_0001", streamId: "fixture_stream_0001",
    streamSeq: seq, text, sentAt: "2026-09-06T00:00:01Z", serverReceivedAt: "2026-09-06T00:00:01Z",
    ...overrides,
  };
}

await test("实际流协调器按序合并，重复帧和旧 reset 不回退内容", async () => {
  const env = streamSetup();
  await env.connect();
  const socket = env.sockets[0];
  socket.frame(frame(1, "reply-stream/reset", "历史"));
  socket.frame(frame(2, "reply-stream/append", "\n\n---\n\n增量"));
  socket.frame(frame(2, "reply-stream/append", "\n\n---\n\n增量"));
  socket.frame(frame(1, "reply-stream/reset", "历史"));
  socket.frame(frame(3, "reply-stream/append", "回复"));
  socket.frame(frame(4, "reply-stream/end", undefined, { outcome: "completed" }));
  socket.frame(frame(4, "reply-stream/end", undefined, { outcome: "completed" }));
  assert.equal(env.updates.length, 3);
  assert.equal(env.updates.at(-1).text, "历史\n\n---\n\n增量回复");
  assert.deepEqual(env.ends, ["completed"]);
  env.coordinator.disconnect();
  assert.equal(socket.handlers.size, 0);
  assert.equal(socket.closed, true);
});

await test("乱序缺口断开并通知重连，重连 reset 恢复遗漏片段", async () => {
  const env = streamSetup();
  await env.connect();
  env.sockets[0].frame(frame(1, "reply-stream/reset", "一"));
  env.sockets[0].frame(frame(3, "reply-stream/append", "三"));
  assert.equal(env.statuses.at(-1).connected, false);
  assert.equal(env.updates.at(-1).text, "一");
  assert.equal(env.sockets[0].handlers.size, 0);
  await env.connect();
  env.sockets[1].frame(frame(3, "reply-stream/reset", "一二三"));
  env.sockets[1].frame(frame(4, "reply-stream/append", "四"));
  assert.equal(env.updates.at(-1).text, "一二三四");
});

await test("切换流后丢弃旧流延迟帧，包括相同毫秒生成的 reset", async () => {
  const env = streamSetup();
  await env.connect();
  const socket = env.sockets[0];
  socket.frame(frame(1, "reply-stream/reset", "旧"));
  socket.frame(frame(1, "reply-stream/reset", "新", { streamId: "fixture_stream_0002" }));
  socket.frame(frame(2, "reply-stream/append", "流"));
  socket.frame(frame(1, "reply-stream/reset", "旧"));
  assert.equal(env.updates.length, 2);
  assert.equal(env.updates.at(-1).text, "新");
  assert.equal(socket.closed, false);
});

await test("签名期间退出不创建 socket，已关闭 socket 的迟到回调不更新页面", async () => {
  const signing = deferred();
  const env = streamSetup(() => signing.promise);
  const pending = env.connect();
  env.coordinator.disconnect();
  signing.resolve({});
  await pending;
  assert.equal(env.sockets.length, 0);
  await env.connect();
  const message = env.sockets[0].handlers.get("message");
  env.coordinator.disconnect();
  message({ code: 0 }, JSON.stringify(frame(1, "reply-stream/reset", "过期内容")));
  assert.equal(env.updates.length, 0);
});

await test("非法帧安全断开且不泄露内容", async () => {
  for (const invalid of [null, frame(1, "reply-stream/reset", "不应展示", { bindingEpoch: 2 })]) {
    const env = streamSetup();
    await env.connect();
    env.sockets[0].frame(invalid);
    assert.equal(env.updates.length, 0);
    assert.equal(env.sockets[0].closed, true);
  }
});

await test("桌面只读事件监听按任务过滤、合并增量并清理所有监听", async () => {
  const listeners = new Map();
  const timers = new Map();
  const emitted = [];
  let timerId = 0;
  const context = vm.createContext({
    window: {
      __codexPlusRemoteSessionRecoveryDispatcher: {
        subscribe(method, callback) {
          assert.equal(listeners.has(method), false, "不能重复订阅事件");
          listeners.set(method, callback);
          return () => listeners.delete(method);
        },
      },
      fixtureBinding: text => emitted.push(JSON.parse(text)),
    },
    setInterval(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const observer = vm.runInContext(`(${await readFile(path.join(root,
    "crates/codex-plus-core/src/remote_mobile/live_source.js"), "utf8")})`, context);
  observer(["fixture_task_0001"], "fixtureBinding", 15000);
  observer(["fixture_task_0001"], "fixtureBinding", 15000);
  assert.equal(listeners.size, 3);
  const dispatch = (method, params) => listeners.get(method)(params);
  dispatch("item/agentMessage/delta", { threadId: "not_selected", itemId: "item0", delta: "不应上传" });
  dispatch("item/agentMessage/delta", { threadId: "fixture_task_0001", itemId: "unknown_item", delta: "缺少前缀" });
  dispatch("item/started", { threadId: "fixture_task_0001", item: {
    id: "private_item", type: "agentMessage", channel: "analysis", text: "不应上传",
  } });
  dispatch("item/agentMessage/delta", { threadId: "fixture_task_0001", itemId: "private_item", delta: "不应上传" });
  assert.equal(emitted.length, 0);
  dispatch("item/started", { threadId: "fixture_task_0001", item: {
    id: "item1", type: "agentMessage", channel: "final", text: "",
  } });
  dispatch("item/agentMessage/delta", { threadId: "fixture_task_0001", itemId: "item1", delta: "流式" });
  dispatch("item/agentMessage/delta", { threadId: "fixture_task_0001", itemId: "item1", delta: "回复" });
  assert.equal(emitted.length, 1);
  const [id, timer] = [...timers].find(([, timer]) => timer.delay === 100);
  timers.delete(id);
  timer.callback();
  assert.equal(emitted.at(-1).text, "流式回复");
  assert.equal(emitted.at(-1).complete, false);
  dispatch("item/completed", { threadId: "fixture_task_0001", item: {
    id: "item1", type: "agentMessage", channel: "final", text: "流式回复完成",
  } });
  assert.equal(emitted.at(-1).text, "流式回复完成");
  assert.equal(emitted.at(-1).complete, true);
  observer([], "fixtureBinding", 15000);
  dispatch("item/agentMessage/delta", { threadId: "fixture_task_0001", itemId: "item2", delta: "退出后不上传" });
  assert.equal(emitted.length, 3);
  context.window.__xuanMobileReplyObserver.dispose();
  assert.equal(listeners.size, 0);
  assert.equal(timers.size, 0);
});

await test("历史渲染解析不限制回复条数或长正文，未闭合代码块仍增量显示", async () => {
  const markdown = await readFile(path.join(ets, "components/MarkdownPreview.ets"), "utf8");
  const context = vm.createContext({ $r: value => value });
  vm.runInContext(compile(markdown.slice(0, markdown.indexOf("@Component"))), context);
  const replies = Array.from({ length: 1200 }, (_, index) => `第${index + 1}条回复`);
  const text = replies.join("\n\n---\n\n");
  const blocks = context.markdownBlocks(text);
  assert.deepEqual(Array.from(blocks.filter(block => block.kind === "paragraph"), block => block.text), replies);
  const long = "完整中文回复".repeat(100000);
  assert.equal(context.markdownBlocks(long)[0].text, long);
  assert.equal(context.markdownBlocks("```ts\nconst value =")[0].text, "const value =");
});

await test("订阅连接挂起超时只触发一次恢复且退出取消超时", async () => {
  const env = streamSetup(undefined, false);
  await env.connect();
  assert.equal(env.statuses.length, 0);
  const [id, timer] = [...env.timers][0];
  assert.equal(timer.delay, 15000);
  env.timers.delete(id);
  timer.callback();
  assert.equal(env.statuses.length, 1);
  assert.equal(env.statuses[0].connected, false);
  assert.equal(env.sockets[0].closed, true);
  await env.connect();
  assert.equal(env.timers.size, 1);
  env.coordinator.disconnect();
  assert.equal(env.timers.size, 0);
  assert.equal(env.sockets[1].handlers.size, 0);
});
console.log(JSON.stringify({ ok: true, checks, verification: "实际页面方法与模拟网络、定时器，不代表真机验证" }));
