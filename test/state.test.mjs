import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readState, writeState } from "../scripts/lib/state.mjs";

test("writes state atomically and counts statuses", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-state-"));
  const oldHome = process.env.CODEX_WORKFLOW_HOME;
  process.env.CODEX_WORKFLOW_HOME = path.join(dir, "workflow-home");
  try {
    const state = {
      run_id: "run-1",
      name: "demo",
      cwd: dir,
      status: "running",
      agents: [
        { status: "running" },
        { status: "done" },
        { status: "failed" },
        { status: "stale" },
      ],
    };
    await writeState(dir, state);
    const saved = await readState(dir, "run-1");
    assert.deepEqual(saved.counts, { pending: 0, running: 1, done: 1, failed: 1, stale: 1, stopped: 0 });
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_WORKFLOW_HOME;
    else process.env.CODEX_WORKFLOW_HOME = oldHome;
    await rm(dir, { recursive: true, force: true });
  }
});
