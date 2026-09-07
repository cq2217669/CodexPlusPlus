import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";

const SOURCE_URL = new URL("../../../assets/inject/workspace-search-inject.js", import.meta.url);

describe("workspace search injection", () => {
  it("uses the bridge task lifecycle and the Ctrl+Shift+F shortcut", async () => {
    const source = await readFile(SOURCE_URL, "utf8");

    assert.match(source, /__codexPlusWorkspaceSearch/);
    assert.match(source, /\/workspace-search\/start/);
    assert.match(source, /\/workspace-search\/poll/);
    assert.match(source, /\/workspace-search\/cancel/);
    assert.match(source, /event\.ctrlKey && event\.shiftKey/);
    assert.match(source, /event\.preventDefault\(\)/);
  });

  it("renders file content as text and keeps direct file opening optional", async () => {
    const source = await readFile(SOURCE_URL, "utf8");

    assert.match(source, /text\.textContent = String\(item\.text \|\| ""\)/);
    assert.match(source, /document\.createTextNode/);
    assert.match(source, /callCodexApi\("open-file"/);
    assert.match(source, /当前 Codex 版本不支持直接跳转/);
  });
});
