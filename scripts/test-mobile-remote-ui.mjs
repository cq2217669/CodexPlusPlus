import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(root, "apps/codex-plus-manager");
const runtime = process.argv[2];
assert.ok(runtime, "需要已安装的 Playwright 模块目录");
const { chromium } = await import(pathToFileURL(path.join(runtime, "playwright/index.mjs")).href);
const { createServer } = await import(pathToFileURL(path.join(app, "node_modules/vite/dist/node/index.js")).href);
const output = path.join(root, "target/mobile-remote-qa");
await mkdir(output, { recursive: true });
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const server = await createServer({
  root: app,
  configFile: path.join(app, "vite.config.ts"),
  server: { host: "127.0.0.1", port, strictPort: true, hmr: false },
  plugins: [{
    name: "mobile-remote-isolated-ui-test",
    resolveId(id) { if (id === "/mobile-remote-test.js") return "\0mobile-remote-test.js"; },
    load(id) {
      if (id === "\0mobile-remote-test.js") return `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { MobileRemoteScreen } from "/src/MobileRemoteScreen.tsx";
        import "/src/styles.css";
        createRoot(document.getElementById("app")).render(React.createElement(MobileRemoteScreen));
      `;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== "/mobile-remote-test") { next(); return; }
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1">
          <style>body{margin:0;padding:24px}#app{max-width:1100px;margin:auto}</style></head>
          <body><main id="app"></main><script type="module" src="/mobile-remote-test.js"></script></body></html>`);
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const tasks = [
      { id: "isolated_task_0001", name: "官方任务回复同步接入", workspaceName: "轩++" },
      { id: "isolated_task_0002", name: "较长的中文任务名称用于检查窄屏显示时是否正确换行且不遮挡其他内容", workspaceName: "独立测试工作区" },
    ];
    const state = {
      enabled: true, connected: true, bound: false, message: "手机已扫码，等待本机确认",
      qrImage: null, qrExpiresAt: null, selected: [], lastSyncedAt: null, syncError: null,
      pending: { requestId: "isolated_request_0001", phoneName: "集成测试手机", safetyPhrase: "青山 · 流水",
        expiresAt: new Date(Date.now() + 300000).toISOString() },
    };
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        if (command === "mobile_remote_tasks") return structuredClone(tasks);
        if (command === "mobile_remote_select") state.selected = args.selected;
        if (command === "mobile_remote_confirm") {
          state.bound = args.confirmed; state.pending = null;
          state.message = args.confirmed ? "手机已绑定" : "已拒绝本次绑定";
        }
        if (command === "mobile_remote_enable") {
          state.enabled = args.enabled; state.connected = args.enabled;
          state.message = args.enabled ? "手机已绑定" : "手机连接已暂停";
        }
        return structuredClone(state);
      },
    };
  });
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.goto(`http://127.0.0.1:${address.port}/mobile-remote-test`);
  await page.getByRole("button", { name: "确认绑定", exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, "desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "确认绑定", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "手机已绑定" }).waitFor();
  const firstTask = page.locator(".mobile-remote-task").first().getByRole("checkbox");
  await firstTask.check();
  await page.getByText("已选择 1 项", { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "搜索任务" }).fill("较长");
  assert.equal(await page.locator(".mobile-remote-task").count(), 1);
  await page.getByRole("textbox", { name: "搜索任务" }).fill("");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, "mobile.png"), fullPage: true });
  const geometry = await page.evaluate(() => ({
    viewport: window.innerWidth,
    width: document.documentElement.scrollWidth,
    rows: [...document.querySelectorAll(".mobile-remote-task")].map(row => {
      const rectangle = row.getBoundingClientRect();
      return [...row.querySelectorAll("span, small")].every(node => {
        const child = node.getBoundingClientRect();
        return child.left >= rectangle.left && child.right <= rectangle.right + 1 && child.bottom <= rectangle.bottom + 1;
      });
    }),
  }));
  assert.ok(geometry.width <= geometry.viewport, "窄屏不得横向溢出");
  assert.ok(geometry.rows.every(Boolean), "任务文字不得越过行边界");
  assert.ok(!(await page.locator("body").innerText()).includes("isolated_"), "界面不得展示内部标识");
  await page.getByRole("checkbox", { name: "连接手机", exact: true }).uncheck();
  await page.getByRole("status").filter({ hasText: "手机连接已暂停" }).waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ["确认绑定", "选择任务", "搜索", "暂停连接", "窄屏布局", "内部标识隐藏"], transport: "仅模拟界面调用", screenshots: output }));
} finally {
  if (browser) await browser.close();
  await server.close();
}
