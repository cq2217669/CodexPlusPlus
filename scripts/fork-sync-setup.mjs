#!/usr/bin/env node
/**
 * 一次性安装 fork 的本地 git 配置（幂等，可重复执行）。
 *
 *   node scripts/fork-sync-setup.mjs
 *
 * 为什么需要这套配置
 * ------------------
 * 本 fork 在上游高频演进的文件上做了改动（renderer-inject 分片、bridge.rs）。
 * 每次同步上游都撞同一批冲突，其中一类是「假冲突」——assets/inject/renderer-inject.js
 * 是脚本从分片生成的产物，根本不该手工合并。这套配置把假冲突彻底消掉，并让真冲突
 * 可被自动重放：
 *
 *   1. 产物合并策略：assets/inject/renderer-inject.js 走 merge=ours，
 *      内容由 scripts/git-hooks/pre-commit 在提交前按分片重建。
 *   2. rerere：记录一次冲突解决过程，之后同形态冲突自动重放。
 *
 * 所有配置都写在本地（.git/info/attributes 与 git config），不进版本库，
 * 因此不会和上游的 .gitattributes 产生新的冲突。
 *
 * 注意：统一用异步 spawn 调用外部命令。部分受限环境（含 CI 沙箱）会拒绝
 * node 的同步 spawnSync/execFileSync（EBUSY），异步 spawn 不受影响。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

function run(command, args) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => reject(new Error(`${command} 启动失败：${error.message}`)));
    child.on("close", (code) => {
      const result = { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
      if (result.ok) resolve(result);
      else reject(new Error(`${command} ${args.join(" ")} 退出码 ${code}\n${result.stderr || result.stdout}`));
    });
  });
}

const git = (...args) => run("git", args);

const steps = [];

// 1. 钩子目录指向版本库内的 scripts/git-hooks，随代码一起分发。
await git("config", "core.hooksPath", "scripts/git-hooks");
steps.push("core.hooksPath -> scripts/git-hooks");

const hookPath = path.join(repoRoot, "scripts", "git-hooks", "pre-commit");
if (process.platform !== "win32") {
  fs.chmodSync(hookPath, 0o755);
  steps.push("pre-commit 已置为可执行");
}

// 2. rerere：冲突解决过程记录与自动重放。
await git("config", "rerere.enabled", "true");
await git("config", "rerere.autoupdate", "true");
steps.push("rerere.enabled / rerere.autoupdate -> true");

// 3. merge=ours 驱动。产物内容由 pre-commit 钩子重建，合并阶段保留本地版本即可。
await git("config", "merge.ours.driver", "true");
steps.push("merge.ours.driver -> true");

// 4. 本地属性文件：只影响本克隆，不动上游跟踪的 .gitattributes。
const gitDir = (await git("rev-parse", "--git-dir")).stdout;
const infoDir = path.join(path.resolve(repoRoot, gitDir), "info");
fs.mkdirSync(infoDir, { recursive: true });
const attributesPath = path.join(infoDir, "attributes");
const rule = "assets/inject/renderer-inject.js merge=ours";
const existing = fs.existsSync(attributesPath) ? fs.readFileSync(attributesPath, "utf8") : "";
if (existing.split(/\r?\n/).some((line) => line.trim() === rule)) {
  steps.push(".git/info/attributes 已包含产物合并规则");
} else {
  const next = existing && !existing.endsWith("\n") ? `${existing}\n${rule}\n` : `${existing}${rule}\n`;
  fs.writeFileSync(attributesPath, next, "utf8");
  steps.push(`.git/info/attributes += ${rule}`);
}

// 5. 自检：产物当前是否与分片一致（不一致不阻塞安装，只提示）。
let drift;
try {
  const checked = await run(process.execPath, [path.join(repoRoot, "scripts", "assemble-renderer-inject.mjs"), "--check"]);
  drift = checked.stdout || "产物与分片一致";
} catch (error) {
  drift = `产物与分片不一致，提交时钩子会自动重建：\n${error.message}`;
}

console.log("fork 本地 git 配置已安装：");
for (const step of steps) console.log(`  - ${step}`);
console.log(`\n自检：${drift}`);
console.log("\n后续同步上游：node scripts/sync-upstream.mjs");
