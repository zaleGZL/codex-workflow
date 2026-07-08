import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRun, requestPause, resumeRun } from "../scripts/lib/runtime.mjs";
import { readState } from "../scripts/lib/state.mjs";

test("runs a pipeline with fake codex and preserves ordered results", async () => {
  const env = await setupFakeRepo();
  const oldPath = process.env.PATH;
  const oldHome = process.env.CODEX_WORKFLOW_HOME;
  process.env.PATH = `${env.bin}:${oldPath}`;
  process.env.CODEX_WORKFLOW_HOME = path.join(env.root, "workflow-home");
  try {
    const workflow = path.join(env.repo, "workflow.js");
    await writeFile(workflow, `
export const meta = { name: "ordered" };
export default async ({ agent, pipeline }) => pipeline(["a", "b"], item =>
  agent("prompt " + item, { label: item, mode: "read" })
);
`);
    const state = await createRun(workflow, { cwd: env.repo, concurrency: 2 });
    assert.equal(state.status, "done");
    assert.equal(state.agents.length, 2);
    assert.equal(state.agents[0].usage.total_tokens, 15);
    assert.equal(state.result[0].result.includes("prompt a"), true);
    assert.equal(state.result[1].result.includes("prompt b"), true);
  } finally {
    process.env.PATH = oldPath;
    restoreEnv("CODEX_WORKFLOW_HOME", oldHome);
    await rm(env.root, { recursive: true, force: true });
  }
});

test("pause prevents pending agents and resume completes them", async () => {
  const env = await setupFakeRepo();
  const oldPath = process.env.PATH;
  const oldHome = process.env.CODEX_WORKFLOW_HOME;
  process.env.PATH = `${env.bin}:${oldPath}`;
  process.env.CODEX_WORKFLOW_HOME = path.join(env.root, "workflow-home");
  try {
    const workflow = path.join(env.repo, "workflow.js");
    await writeFile(workflow, `
export const meta = { name: "pause-demo" };
export default async ({ agent, pipeline }) => pipeline(["a", "b"], item =>
  agent("prompt " + item, { label: item, mode: "read" })
, { concurrency: 1 });
`);
    const runId = "pause-run";
    const run = createRun(workflow, { cwd: env.repo, concurrency: 1, runId });
    await waitForAgent(env.repo, runId, 1);
    await requestPause(env.repo, runId);
    const paused = await run;
    assert.equal(paused.status, "paused");
    const resumed = await resumeRun(env.repo, runId, { concurrency: 1 });
    assert.equal(resumed.status, "done");
  } finally {
    process.env.PATH = oldPath;
    restoreEnv("CODEX_WORKFLOW_HOME", oldHome);
    await rm(env.root, { recursive: true, force: true });
  }
});

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function setupFakeRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-runtime-"));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  await mkdir(repo);
  await mkdir(bin);
  await writeFile(path.join(repo, "README.md"), "");
  await run("git", ["init"], repo);
  await run("git", ["config", "user.email", "test@example.com"], repo);
  await run("git", ["config", "user.name", "Test"], repo);
  await run("git", ["add", "README.md"], repo);
  await run("git", ["commit", "-m", "init"], repo);
  const fake = path.join(bin, "codex");
  await writeFile(fake, `#!/usr/bin/env node
const fs = require('fs');
if (process.argv.includes('--version')) process.exit(0);
const out = process.argv[process.argv.indexOf('--output-last-message') + 1];
let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => setTimeout(() => {
  fs.writeFileSync(out, 'result: ' + input);
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 5, reasoning_output_tokens: 2 } }));
  console.log(JSON.stringify({ type: 'result', input }));
}, 50));
`);
  await chmod(fake, 0o755);
  return { root, repo, bin };
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${cmd} failed`)));
  });
}

async function latestRunId(repo) {
  const base = path.join(repo, ".codex", "workflow-runs");
  const { readdir } = await import("node:fs/promises");
  return (await readdir(base)).sort().at(-1);
}

async function waitForAgent(repo, runId, count) {
  for (let i = 0; i < 50; i += 1) {
    const state = await readState(repo, runId).catch(() => null);
    if (state?.agents.length >= count) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for agent");
}
