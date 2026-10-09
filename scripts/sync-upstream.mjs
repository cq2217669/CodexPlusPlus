#!/usr/bin/env node
/**
 * 一条命令同步上游：fetch → merge → 机械部分自动处理 → 重建产物 → 跑验证 → 报告。
 *
 *   node scripts/sync-upstream.mjs            # 合并并停在 commit 之前，供人工复核
 *   node scripts/sync-upstream.mjs --commit   # 复核通过后由脚本收尾提交
 *   node scripts/sync-upstream.mjs --full     # 额外跑 cargo 侧 cdp_bridge 测试
 *
 * 自动处理的部分（不需要人判断）
 * ------------------------------
 *   - assets/inject/renderer-inject.js：生成产物，按分片重建，不做文本合并。
 *   - 已记录过的冲突：由 git rerere 自动重放（需先跑 scripts/fork-sync-setup.mjs）。
 *
 * 仍需要人判断的部分
 * ------------------
 *   - assets/inject/renderer-inject/70-model-catalog.js：本地同步门控与上游
 *     sendRequest 补丁演进在同一批函数里，语义冲突必须人工对齐。
 *     详见 docs/migration/upstream-sync.md。
 *
 * 注意：统一用异步 spawn 调用外部命令。部分受限环境（含 CI 沙箱）会拒绝
 * node 的同步 spawnSync/execFileSync（EBUSY），异步 spawn 不受影响。
 */
import { spawn } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const shouldCommit = argv.includes("--commit");
const fullTests = argv.includes("--full");

const ARTIFACT = "assets/inject/renderer-inject.js";
const ASSEMBLER = "scripts/assemble-renderer-inject.mjs";

function run(command, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => reject(new Error(`${command} 启动失败：${error.message}`)));
    child.on("close", (code) => {
      const result = { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
      if (result.ok || allowFailure) resolve(result);
      else reject(new Error(`${command} ${args.join(" ")} 退出码 ${code}\n${result.stderr || result.stdout}`));
    });
  });
}

const git = (...args) => run("git", args);
const gitTry = (...args) => run("git", args, { allowFailure: true });
const node = (...args) => run(process.execPath, args, { allowFailure: true });

async function unmergedFiles() {
  const result = await gitTry("diff", "--name-only", "--diff-filter=U");
  return result.stdout ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
}

async function mergeInProgress() {
  return (await gitTry("rev-parse", "--verify", "MERGE_HEAD")).ok;
}

async function rebuildArtifact() {
  const assembled = await node(ASSEMBLER);
  if (!assembled.ok) throw new Error(`产物重建失败\n${assembled.stderr || assembled.stdout}`);
  await git("add", ARTIFACT);
  return assembled.stdout;
}

function reportUnresolved(files) {
  console.error("\n仍有需要人工判断的冲突：");
  for (const file of files) console.error(`  - ${file}`);
  console.error(
    [
      "",
      "处理建议：",
      "  1. 已记录过的形态会被 rerere 自动重放，直接重跑一次本脚本即可",
      "  2. 需要语义对齐的：手工改好后 git add <file>",
      "  3. 重跑：node scripts/sync-upstream.mjs",
      "",
      "语义对齐要点见 docs/migration/upstream-sync.md。",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------- 前置检查
if (await mergeInProgress()) {
  console.error("检测到未完成的合并，请先处理或 git merge --abort 后再运行。");
  process.exit(1);
}

const dirty = (await gitTry("status", "--porcelain")).stdout;
if (dirty) {
  // 未跟踪文件（?? 开头）不阻塞合并，只有已跟踪文件的改动需要先处理。
  const lines = dirty
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("??") && !line.includes(ARTIFACT));
  if (lines.length) {
    console.error("工作区有未提交改动，先处理干净再同步：");
    for (const line of lines) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log("工作区仅有产物改动或未跟踪文件，提交前会由钩子重建，继续。");
}

// ---------------------------------------------------------------- fetch + merge
console.log("拉取上游 ...");
await git("fetch", "upstream", "main");
const target = (await git("rev-parse", "--short", "upstream/main")).stdout;
console.log(`上游 main = ${target}`);

const merge = await gitTry("merge", "--no-commit", "--no-ff", "upstream/main");
if (merge.stdout || merge.stderr) console.log([merge.stdout, merge.stderr].filter(Boolean).join("\n"));

if (!(await mergeInProgress())) {
  console.log("\n上游没有新提交，无需合并。");
  process.exit(0);
}

// ---------------------------------------------------------------- 自动处理冲突
let conflicted = await unmergedFiles();
if (conflicted.length) {
  console.log(`\n冲突文件 ${conflicted.length} 个，先尝试 rerere 自动重放 ...`);
  await gitTry("rerere");
  conflicted = await unmergedFiles();
}

const artifactConflicted = conflicted.includes(ARTIFACT);
if (artifactConflicted) {
  console.log(`产物 ${ARTIFACT} 是生成文件，按分片重建（不做文本合并）`);
  conflicted = conflicted.filter((file) => file !== ARTIFACT);
  await rebuildArtifact();
}

if (conflicted.length) {
  reportUnresolved(conflicted);
  process.exit(1);
}

// 无冲突也要重建一次：上游可能只改了分片，产物需跟着更新。
if (!artifactConflicted) await rebuildArtifact();

// ---------------------------------------------------------------- 验证
console.log("\n验证 ...");
const check = await node(ASSEMBLER, "--check");
console.log(check.ok ? `  ${check.stdout}` : `  产物一致性校验失败：\n${check.stderr || check.stdout}`);

const injectTest = await node("--test", "apps/codex-plus-manager/src/renderer-inject.test.ts");
const injectSummary = injectTest.stdout.split(/\r?\n/).filter((line) => /^# (pass|fail)/.test(line)).join(" ");
console.log(`  renderer-inject.test.ts: ${injectSummary || "未取到汇总"}`);

if (fullTests) {
  const cargo = await run("cargo", ["test", "-p", "codex-plus-core", "--test", "cdp_bridge"], { allowFailure: true });
  const cargoSummary = cargo.stdout.split(/\r?\n/).filter((line) => line.startsWith("test result:")).join(" ");
  console.log(`  cdp_bridge: ${cargoSummary || "未取到汇总"}`);
}

// ---------------------------------------------------------------- 收尾
if (shouldCommit) {
  await git("commit", "--no-verify", "-m", `Merge upstream/main (${target}) into codex/migrate-official-1.3.0`);
  console.log(`\n已提交合并 ${target}。`);
} else {
  console.log(
    [
      "",
      "合并已就绪（尚未提交）。复核：",
      "  git diff --cached --stat",
      "确认后收尾：",
      `  git commit -m "Merge upstream/main (${target}) into codex/migrate-official-1.3.0"`,
    ].join("\n"),
  );
}
