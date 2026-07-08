import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serve } from "../scripts/lib/server.mjs";
import { writeState } from "../scripts/lib/state.mjs";

test("serves dashboard and state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-server-"));
  const oldHome = process.env.CODEX_WORKFLOW_HOME;
  process.env.CODEX_WORKFLOW_HOME = path.join(dir, "workflow-home");
  try {
    await writeState(dir, {
      run_id: "run-1",
      name: "demo",
      cwd: dir,
      status: "running",
      agents: [],
      pause_requested: false,
    });
    const server = await serve(dir, "run-1", 0, { open: false, portExplicit: true });
    const port = server.address().port;
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const state = await (await fetch(`http://127.0.0.1:${port}/state.json`)).json();
    await fetch(`http://127.0.0.1:${port}/pause`, { method: "POST" });
    server.close();
    assert.equal(html.includes("Codex Workflow"), true);
    assert.equal(state.run_id, "run-1");
  } finally {
    restoreEnv("CODEX_WORKFLOW_HOME", oldHome);
    await rm(dir, { recursive: true, force: true });
  }
});

test("serve falls back when preferred port is busy", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-server-port-"));
  const blocker = http.createServer((_req, res) => res.end("busy"));
  const oldHome = process.env.CODEX_WORKFLOW_HOME;
  process.env.CODEX_WORKFLOW_HOME = path.join(dir, "workflow-home");
  try {
    await writeState(dir, {
      run_id: "run-1",
      name: "demo",
      cwd: dir,
      status: "running",
      agents: [],
      pause_requested: false,
    });
    await new Promise(resolve => blocker.listen(0, "127.0.0.1", resolve));
    const busyPort = blocker.address().port;
    const server = await serve(dir, "run-1", busyPort, { open: false });
    const port = server.address().port;
    server.close();
    assert.notEqual(port, busyPort);
  } finally {
    blocker.close();
    restoreEnv("CODEX_WORKFLOW_HOME", oldHome);
    await rm(dir, { recursive: true, force: true });
  }
});

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
