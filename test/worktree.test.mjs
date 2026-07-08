import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyPatch, diffWorktree, hasOverlappingFiles, shouldUseWorktree, worktreeInfo } from "../scripts/lib/worktree.mjs";

test("detects overlapping and missing edit files", () => {
  assert.equal(hasOverlappingFiles([
    { mode: "edit", files: ["a.js"] },
    { mode: "edit", files: ["b.js"] },
  ]), false);
  assert.equal(hasOverlappingFiles([
    { mode: "edit", files: ["a.js"] },
    { mode: "edit", files: ["a.js"] },
  ]), true);
  assert.equal(hasOverlappingFiles([{ mode: "edit", files: [] }]), true);
});

test("chooses worktree policy", () => {
  const agent = { mode: "edit", files: ["a.js"] };
  assert.equal(shouldUseWorktree(agent, [agent], "always").useWorktree, true);
  assert.equal(shouldUseWorktree(agent, [agent], "never").useWorktree, false);
  assert.equal(shouldUseWorktree({ mode: "read" }, [agent], "always").useWorktree, false);
  assert.equal(shouldUseWorktree(agent, [
    { mode: "edit", files: ["a.js"] },
    { mode: "edit", files: ["a.js"] },
  ], "auto").useWorktree, true);
});

test("worktree naming is stable", () => {
  const oldHome = process.env.CODEX_WORKFLOW_HOME;
  process.env.CODEX_WORKFLOW_HOME = "/tmp/codex-workflow-home";
  const info = worktreeInfo("/repo", "run-1", "agent-001");
  try {
    assert.equal(info.worktree, "/tmp/codex-workflow-home/worktrees/run-1/agent-001");
    assert.equal(info.branch, "codex/workflow/run-1/agent-001");
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_WORKFLOW_HOME;
    else process.env.CODEX_WORKFLOW_HOME = oldHome;
  }
});

test("diffWorktree and applyPatch move a worktree change to cwd", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-diff-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  try {
    await run("git", ["init", repo]);
    await run("git", ["config", "user.email", "test@example.com"], repo);
    await run("git", ["config", "user.name", "Test"], repo);
    await writeFile(path.join(repo, "a.txt"), "before\n");
    await run("git", ["add", "a.txt"], repo);
    await run("git", ["commit", "-m", "init"], repo);
    await run("git", ["worktree", "add", worktree, "HEAD"], repo);
    await writeFile(path.join(worktree, "a.txt"), "after\n");
    const diff = await diffWorktree(worktree);
    assert.equal(diff.code, 0);
    assert.equal(diff.stdout.includes("after"), true);
    const applied = await applyPatch(repo, diff.stdout);
    assert.equal(applied.code, 0);
    assert.equal(await readFile(path.join(repo, "a.txt"), "utf8"), "after\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function run(cmd, args, cwd, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0 || capture) resolve({ code: code ?? 1, stdout, stderr });
      else reject(new Error(stderr || stdout || `${cmd} failed`));
    });
  });
}
