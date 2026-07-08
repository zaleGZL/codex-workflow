import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serve } from "../scripts/lib/server.mjs";
import { writeState } from "../scripts/lib/state.mjs";

test("serves dashboard and state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-server-"));
  try {
    await writeState(dir, {
      run_id: "run-1",
      name: "demo",
      cwd: dir,
      status: "running",
      agents: [],
      pause_requested: false,
    });
    const server = serve(dir, "run-1", 0);
    await once(server, "listening");
    const port = server.address().port;
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const state = await (await fetch(`http://127.0.0.1:${port}/state.json`)).json();
    await fetch(`http://127.0.0.1:${port}/pause`, { method: "POST" });
    server.close();
    assert.equal(html.includes("Codex Workflow"), true);
    assert.equal(state.run_id, "run-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
