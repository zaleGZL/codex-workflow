import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
      agents: [{ id: "agent-001", label: "a", status: "running", usage: { total_tokens: 15 } }],
      pause_requested: false,
    });
    const server = await serve(dir, "run-1", 0, { open: false, portExplicit: true });
    const port = server.address().port;
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const state = await (await fetch(`http://127.0.0.1:${port}/state.json`)).json();
    await fetch(`http://127.0.0.1:${port}/pause`, { method: "POST" });
    server.close();
    assert.equal(html.includes("Codex Workflow"), true);
    assert.equal(html.includes("<th>Tokens</th>"), true);
    assert.equal(html.includes(">Pause<"), false);
    assert.equal(html.includes(">Resume<"), false);
    assert.equal(html.includes("post('/pause')"), false);
    assert.equal(html.includes("post('/resume')"), false);
    assert.equal(state.run_id, "run-1");
  } finally {
    restoreEnv("CODEX_WORKFLOW_HOME", oldHome);
    await rm(dir, { recursive: true, force: true });
  }
});

test("auto-closes dashboard when run finishes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-server-close-"));
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
    const server = await serve(dir, "run-1", 0, { open: false, portExplicit: true, exitOnDone: true });
    await writeState(dir, {
      run_id: "run-1",
      name: "demo",
      cwd: dir,
      status: "done",
      agents: [],
      pause_requested: false,
    });
    await new Promise(resolve => server.on("close", resolve));
    assert.equal(server.listening, false);
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

test("serves agent stop and rerun controls", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-server-agent-"));
  const bin = path.join(dir, "bin");
  const oldHome = process.env.CODEX_WORKFLOW_HOME;
  const oldPath = process.env.PATH;
  process.env.CODEX_WORKFLOW_HOME = path.join(dir, "workflow-home");
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    await mkdir(bin);
    const workflow = path.join(dir, "workflow.js");
    await writeFile(workflow, `export default async ({ agent }) => agent("again", { label: "one" });\n`);
    const fake = path.join(bin, "codex");
    await writeFile(fake, `#!/usr/bin/env node
const fs = require('fs');
if (process.argv.includes('--version')) process.exit(0);
const out = process.argv[process.argv.indexOf('--output-last-message') + 1];
process.stdin.resume();
process.stdin.on('end', () => {
  fs.writeFileSync(out, 'done');
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
});
`);
    await chmod(fake, 0o755);
    await writeState(dir, {
      run_id: "run-1",
      name: "demo",
      cwd: dir,
      workflow_path: workflow,
      status: "running",
      agents: [{ id: "agent-001", label: "a", status: "running", pid: 99999999 }],
      pause_requested: false,
    });
    const server = await serve(dir, "run-1", 0, { open: false, portExplicit: true });
    const port = server.address().port;
    const stopped = await (await fetch(`http://127.0.0.1:${port}/agents/agent-001/stop`, { method: "POST" })).json();
    assert.equal(stopped.agents[0].status, "stopped");
    await writeState(dir, {
      run_id: "run-1",
      name: "demo",
      cwd: dir,
      workflow_path: workflow,
      status: "done",
      agents: [{ id: "agent-001", label: "a", status: "done" }],
      pause_requested: false,
    });
    const rerun = await (await fetch(`http://127.0.0.1:${port}/agents/agent-001/rerun`, { method: "POST" })).json();
    server.close();
    assert.equal(rerun.status, "done");
    assert.equal(rerun.agents[0].status, "done");
  } finally {
    process.env.PATH = oldPath;
    restoreEnv("CODEX_WORKFLOW_HOME", oldHome);
    await rm(dir, { recursive: true, force: true });
  }
});

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
