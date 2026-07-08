import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeState } from "../scripts/lib/state.mjs";

test("cli status reads a fixture state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-cli-"));
  try {
    await writeState(dir, {
      run_id: "run-1",
      name: "demo",
      cwd: dir,
      status: "running",
      agents: [{ status: "done" }],
    });
    const result = await runNode(["scripts/cli.mjs", "status", "run-1", "--cwd", dir]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.includes("demo running"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli run reports missing codex", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-missing-codex-"));
  const oldPath = process.env.PATH;
  process.env.PATH = dir;
  try {
    const result = await runNode(["scripts/cli.mjs", "run", "examples/research-files.workflow.js"]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stderr.includes("Codex CLI is not installed"), true);
  } finally {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  }
});

function runNode(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.on("exit", code => resolve({ code, stdout, stderr }));
  });
}
