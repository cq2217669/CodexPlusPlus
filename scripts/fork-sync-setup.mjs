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
 * 所有配置都写在本地（.git/hooks、.git/info/attributes 与 git config），不进版本库，
 * 因此不会和上游的 .gitattributes 产生新的冲突。
 *
 * 两个刻意的实现选择
 * ------------------
 *   - 钩子以「强制 LF」写入 .git/hooks/pre-commit，而不是用 core.hooksPath 指向
 *     版本库内的目录：.gitattributes 只对 *.sh 强制 LF，无扩展名的 pre-commit 在
 *     Windows 上会被检出为 CRLF，`#!/bin/sh\r` 会让钩子直接失效。
 *   - 统一用异步 spawn 调用外部命令：部分受限环境（含 CI 沙箱）会拒绝 node 的
 *     同步 spawnSync/execFileSync（EBUSY），异步 spawn 不受影响。
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
const gitTry = (...args) => run("git", args).catch((error) => ({ ok: false, stdout: "", stderr: error.message }));

const steps = [];
const gitDir = path.resolve(repoRoot, (await git("rev-parse", "--git-dir")).stdout);

// 1. 钩子：源文件在版本库里，安装时强制 LF 写进 .git/hooks。
const hookSource = path.join(repoRoot, "scripts", "git-hooks", "pre-commit");
const hookTarget = path.join(gitDir, "hooks", "pre-commit");
const hookBody = fs.readFileSync(hookSource, "utf8").replace(/\r\n/g, "\n");
if (fs.existsSync(hookTarget)) {
  const current = fs.readFileSync(hookTarget, "utf8").replace(/\r\n/g, "\n");
  if (current !== hookBody) {
    const backup = path.join(gitDir, "hooks", "pre-commit.fork-backup");
    fs.writeFileSync(backup, current, "utf8");
    steps.push(`原有 pre-commit 已备份为 ${path.relative(repoRoot, backup)}`);
  }
}
fs.mkdirSync(path.dirname(hookTarget), { recursive: true });
fs.writeFileSync(hookTarget, hookBody, "utf8");
if (process.platform !== "win32") fs.chmodSync(hookTarget, 0o755);
steps.push("pre-commit 钩子已安装到 .git/hooks（强制 LF）");

// 2. 清掉可能残留的 core.hooksPath：指向版本库内目录会踩 CRLF 检出问题。
const hooksPath = (await gitTry("config", "--get", "core.hooksPath")).stdout;
if (hooksPath) {
  await git("config", "--unset", "core.hooksPath").catch(() => {});
  steps.push(`已清除 core.hooksPath（原为 ${hooksPath}），改用 .git/hooks`);
}

// 3. rerere：冲突解决过程记录与自动重放。
await git("config", "rerere.enabled", "true");
await git("config", "rerere.autoupdate", "true");
steps.push("rerere.enabled / rerere.autoupdate -> true");

// 4. merge=ours 驱动。产物内容由 pre-commit 钩子重建，合并阶段保留本地版本即可。
await git("config", "merge.ours.driver", "true");
steps.push("merge.ours.driver -> true");

// 5. 本地属性文件：只影响本克隆，不动上游跟踪的 .gitattributes。
const infoDir = path.join(gitDir, "info");
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

// 6. 自检：属性是否被 git 认到、产物是否与分片一致。
const attr = (await gitTry("check-attr", "merge", "--", "assets/inject/renderer-inject.js")).stdout;
let drift;
try {
  const checked = await run(process.execPath, [path.join(repoRoot, "scripts", "assemble-renderer-inject.mjs"), "--check"]);
  drift = checked.stdout || "产物与分片一致";
} catch (error) {
  drift = `产物与分片不一致，提交时钩子会自动重建：\n${error.message}`;
}

console.log("fork 本地 git 配置已安装：");
for (const step of steps) console.log(`  - ${step}`);
console.log(`\n自检：${attr || "未取到属性"}`);
console.log(`自检：${drift}`);
console.log("\n后续同步上游：node scripts/sync-upstream.mjs");
