import test from "node:test";
import assert from "node:assert/strict";
import { hasOverlappingFiles, shouldUseWorktree, worktreeInfo } from "../scripts/lib/worktree.mjs";

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
  const info = worktreeInfo("/repo", "run-1", "agent-001");
  assert.equal(info.worktree, "/repo/.codex/workflow-worktrees/run-1/agent-001");
  assert.equal(info.branch, "codex/workflow/run-1/agent-001");
});
