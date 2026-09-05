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
