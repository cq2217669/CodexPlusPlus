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

  it("lists Codex projects and binds every search to the selected project's workspace", async () => {
    const source = await readFile(SOURCE_URL, "utf8");

    assert.match(source, /async function syncCurrentWorkspace/);
    assert.match(source, /const current = await currentWorkspacePath\(\)/);
    assert.match(source, /const root = await syncCurrentWorkspace\(\{ resetOnChange: true \}\)/);
    assert.match(source, /<select data-ws-project aria-label="搜索项目">/);
    assert.match(source, /\/workspace-search\/projects/);
    assert.match(source, /async function loadProjects\(\)/);
    assert.match(source, /threadId: threadIdFromRow\(activeThreadRow\(\)\)/);
    assert.match(source, /function normalizedProjects\(values\)/);
    assert.match(source, /function renderProjectOptions\(\)/);
    assert.match(source, /state\.selectionMode = "manual"/);
    assert.match(source, /await setSelectedProject\(state\.projectSelect\.value, \{ resetOnChange: true \}\)/);
    assert.match(source, /option\.textContent = project\.name/);
    assert.match(source, /const nextRoot = project\?\.root \|\| ""/);
    assert.match(source, /输入内容以搜索所选项目/);
    assert.match(source, /function activeThreadRow\(\)/);
    assert.match(source, /\/workspace-search\/current-root/);
    assert.match(source, /function workspacePathFromAncestors\(element\)/);
    assert.match(source, /function workspacePathFromReactAncestors\(element\)/);
    assert.match(source, /fiber = fiber\.return/);
    assert.match(source, /currentProjectPathFromActiveThread/);
    assert.match(source, /currentProjectPathFromSelectedButton/);
    assert.match(source, /currentProjectPathFromMainView/);
    assert.match(source, /"return", "sibling", "child", "alternate", "stateNode", "_owner"/);
    assert.doesNotMatch(source, /__codexPluginMarketplaceLastCwds/);
    assert.doesNotMatch(source, /document\.querySelector\(selector\)/);
  });

  it("uses isolated high-contrast colors for light and dark result rows", async () => {
    const source = await readFile(SOURCE_URL, "utf8");

    assert.match(source, /data-theme="dark"/);
    assert.match(source, /--ws-text:/);
    assert.match(source, /\.ws-match[^}]+color: var\(--ws-text\) !important/s);
    assert.match(source, /\.ws-match\.is-selected[^}]+var\(--ws-surface-selected\) !important/s);
    assert.match(source, /mark[^}]+var\(--ws-mark-bg\)[^}]+var\(--ws-mark-text\)/s);
  });

  it("keeps the header command visually aligned with Codex's native menus", async () => {
    const source = await readFile(SOURCE_URL, "utf8");

    assert.match(source, /button\.textContent = "搜索"/);
    assert.match(source, /function ensureHeaderButton\(\) \{\s+ensureStyles\(\)/);
    assert.match(source, /nativeMenuClass \? `\$\{nativeMenuClass\} \$\{BUTTON_CLASS\}`/);
    assert.match(source, /data-native-menu="false"[^}]+font: 400 14px\/14px/s);
  });
});
