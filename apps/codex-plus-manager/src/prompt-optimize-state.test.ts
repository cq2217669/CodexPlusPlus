import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

type PromptOptimizeState = {
  mode: "idle" | "optimized";
  originalText: string | null;
  optimizedText: string | null;
};

type PromptOptimizeStateApi = {
  create(): PromptOptimizeState;
  saveSnapshotIfApplied(
    state: PromptOptimizeState,
    originalText: string,
    optimizedText: string,
    wasApplied: boolean,
  ): boolean;
  clearSnapshot(state: PromptOptimizeState): void;
  needsRestoreConfirmation(state: PromptOptimizeState, currentText: string): boolean;
};

type PromptOptimizeSaveApi = {
  isSuccessfulSettingsSave(result: unknown): boolean;
};

type PromptOptimizeContextApi = {
  selectRecentTurns(
    turns: Array<{ userText?: string; assistantText?: string }>,
    maxTurns: number,
    maxChars: number,
  ): Array<{ userText?: string; assistantText?: string }>;
  shouldIncludeProjectMap(draft: string, style: string): boolean;
};

async function loadPromptOptimizeState(): Promise<PromptOptimizeStateApi> {
  const source = await readFile(
    new URL("../../../assets/inject/prompt-optimize-inject.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("  const promptOptimizeState = (() => {");
  const end = source.indexOf("\n\n  const runtime =", start);
  assert.ok(start >= 0 && end > start, "prompt optimize state factory should be present");
  const factory = source.slice(start, end).replace(/^  /m, "");
  return Function(`${factory}\nreturn promptOptimizeState;`)() as PromptOptimizeStateApi;
}

async function loadPromptOptimizeSaveApi(): Promise<PromptOptimizeSaveApi> {
  const source = await readFile(
    new URL("../../../assets/inject/prompt-optimize-inject.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("  function isSuccessfulSettingsSave(result) {");
  const end = source.indexOf("\n\n  function installStyle()", start);
  assert.ok(start >= 0 && end > start, "prompt optimize save helper should be present");
  const helper = source.slice(start, end).replace(/^  /m, "");
  return Function(`${helper}\nreturn { isSuccessfulSettingsSave };`)() as PromptOptimizeSaveApi;
}

async function loadPromptOptimizeContext(): Promise<PromptOptimizeContextApi> {
  const source = await readFile(
    new URL("../../../assets/inject/prompt-optimize-inject.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("  const promptOptimizeContext = (() => {");
  const end = source.indexOf("\n\n  const runtime =", start);
  assert.ok(start >= 0 && end > start, "prompt optimize context factory should be present");
  const factory = source.slice(start, end).replace(/^  /m, "");
  return Function(`${factory}\nreturn promptOptimizeContext;`)() as PromptOptimizeContextApi;
}

describe("prompt optimize state", () => {
  it("切换连接来源时保持润色模型可见、可编辑且不变", async () => {
    const source = await readFile(
      new URL("../../../assets/inject/prompt-optimize-inject.js", import.meta.url), "utf8",
    );
    const start = source.indexOf("    const updateConnectionSource = () => {");
    const end = source.indexOf('\n    relayIdEl.addEventListener("change"', start);
    assert.ok(start >= 0 && end > start);
    const field = () => ({
      value: "",
      disabled: false,
      container: { hidden: false },
      closest() { return this.container; },
    });
    const relayIdEl = field();
    const modelEl = field();
    modelEl.value = "polish-best";
    const connectionFields = [field(), field(), field(), field()];
    const update = Function(
      "relayIdEl", "modelEl", "protocolEl", "baseUrlEl", "apiKeyEl", "clearKeyEl",
      `${source.slice(start, end)}\nreturn updateConnectionSource;`,
    )(relayIdEl, modelEl, ...connectionFields);
    for (const sourceId of ["provider-test", "provider-other", "", "provider-test"]) {
      relayIdEl.value = sourceId;
      update();
      assert.equal(modelEl.value, "polish-best");
      assert.equal(modelEl.disabled, false);
      assert.equal(modelEl.container.hidden, false);
      for (const element of connectionFields) {
        assert.equal(element.disabled, Boolean(sourceId));
        assert.equal(element.container.hidden, Boolean(sourceId));
      }
    }
  });

  it("管理器的润色模型输入始终绑定独立配置", async () => {
    const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
    const start = source.indexOf('<Field label="润色模型">');
    const end = source.indexOf("</Field>", start);
    assert.ok(start >= 0 && end > start);
    const field = source.slice(start, end);
    assert.match(field, /value=\{form\.codexAppPromptOptimizeModel\}/);
    assert.match(field, /codexAppPromptOptimizeModel: event\.currentTarget\.value/);
    assert.doesNotMatch(field, /disabled|promptOptimizeProvider/);
  });

  it("复用供应商时独立保存润色模型，不复制或清空手动凭据", async () => {
    const source = await readFile(
      new URL("../../../assets/inject/prompt-optimize-inject.js", import.meta.url), "utf8",
    );
    const start = source.indexOf("  async function saveSettingsFromPanel(");
    const end = source.indexOf("\n\n  function scheduleEnsure()", start);
    assert.ok(start >= 0 && end > start);
    const payloads: unknown[] = [];
    const save = Function("bridgeCall", `
      const PANEL_ATTR = "test-panel";
      const document = { querySelector: () => null };
      const showToast = () => {};
      const refreshSettings = async () => {};
      const closeSettingsPanel = () => {};
      const isSuccessfulSettingsSave = () => true;
      ${source.slice(start, end)}
      return saveSettingsFromPanel;
    `)(async (_path: string, payload: unknown) => {
      payloads.push(payload);
      return { status: "ok" };
    });
    const input = (value: string) => ({ value, checked: true, focus() {} });
    let focused = false;
    await save(input("anthropic"), input(""), { value: "  ", focus() { focused = true; } }, input("manual-test-key"), input("coding"), input(""), input("provider-test"));
    assert.equal(payloads.length, 0);
    assert.equal(focused, true);
    await save(input("anthropic"), input(""), input(" polish-best "), input("manual-test-key"), input("coding"), input(""), input("provider-test"));
    assert.deepEqual(payloads, [{
      codexAppPromptOptimizeRelayId: "provider-test",
      codexAppPromptOptimizeStyle: "coding",
      codexAppPromptOptimizeModel: "polish-best",
    }]);
    await save(input("anthropic"), input("https://manual.example.test/v1"), input("manual-model"), input(""), { value: "concise" }, { checked: false }, input(""));
    assert.deepEqual(payloads[1], {
      codexAppPromptOptimizeRelayId: "",
      codexAppPromptOptimizeStyle: "concise",
      codexAppPromptOptimizeProtocol: "anthropic",
      codexAppPromptOptimizeBaseUrl: "https://manual.example.test/v1",
      codexAppPromptOptimizeModel: "manual-model",
    });
  });

  it("saves the original and optimized text after a successful polish", async () => {
    const stateApi = await loadPromptOptimizeState();
    const state = stateApi.create();

    assert.equal(stateApi.saveSnapshotIfApplied(state, "润色前", "润色后", true), true);

    assert.deepEqual(state, {
      mode: "optimized",
      originalText: "润色前",
      optimizedText: "润色后",
    });
  });

  it("clears the snapshot after restore so a later polish starts fresh", async () => {
    const stateApi = await loadPromptOptimizeState();
    const state = stateApi.create();
    stateApi.saveSnapshotIfApplied(state, "第一次原文", "第一次润色", true);

    stateApi.clearSnapshot(state);

    assert.deepEqual(state, {
      mode: "idle",
      originalText: null,
      optimizedText: null,
    });
  });

  it("does not create a snapshot when polish fails to apply", async () => {
    const stateApi = await loadPromptOptimizeState();
    const state = stateApi.create();

    assert.equal(stateApi.saveSnapshotIfApplied(state, "润色前", "润色后", false), false);

    assert.deepEqual(state, {
      mode: "idle",
      originalText: null,
      optimizedText: null,
    });
  });

  it("requires confirmation when restored text was edited", async () => {
    const stateApi = await loadPromptOptimizeState();
    const state = stateApi.create();
    stateApi.saveSnapshotIfApplied(state, "润色前", "润色后", true);

    assert.equal(stateApi.needsRestoreConfirmation(state, "润色后"), false);
    assert.equal(stateApi.needsRestoreConfirmation(state, "润色后，继续编辑"), true);
  });

  it("accepts a successful settings payload that has no status field", async () => {
    const saveApi = await loadPromptOptimizeSaveApi();

    assert.equal(saveApi.isSuccessfulSettingsSave({ codexAppPromptOptimizeProtocol: "openai" }), true);
    assert.equal(saveApi.isSuccessfulSettingsSave({ status: "ok" }), true);
    assert.equal(saveApi.isSuccessfulSettingsSave({ status: "failed" }), false);
    assert.equal(saveApi.isSuccessfulSettingsSave({ error: "bridge timeout" }), false);
  });
});

describe("prompt optimize context", () => {
  it("keeps only recent conversation turns within the character budget", async () => {
    const contextApi = await loadPromptOptimizeContext();
    const turns = contextApi.selectRecentTurns(
      [
        { userText: "最早用户消息", assistantText: "最早回复" },
        { userText: "上一轮用户消息", assistantText: "上一轮回复" },
        { userText: "最近用户消息", assistantText: "最近回复" },
      ],
      2,
      100,
    );

    assert.deepEqual(turns, [
      { userText: "上一轮用户消息", assistantText: "上一轮回复" },
      { userText: "最近用户消息", assistantText: "最近回复" },
    ]);
  });

  it("requests a project map only for coding or project-related drafts", async () => {
    const contextApi = await loadPromptOptimizeContext();

    assert.equal(contextApi.shouldIncludeProjectMap("让表达更自然", "structured"), false);
    assert.equal(contextApi.shouldIncludeProjectMap("修改当前项目的测试", "structured"), true);
    assert.equal(contextApi.shouldIncludeProjectMap("继续处理", "coding"), true);
  });
});
