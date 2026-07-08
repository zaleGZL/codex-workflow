#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRun, requestPause, rerunAgent, resumeRun, stopAgent } from "./lib/runtime.mjs";
import { serve } from "./lib/server.mjs";
import { formatSummary, readState, runsDir } from "./lib/state.mjs";

const args = process.argv.slice(2);
const command = args.shift();

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  if (!command || command === "help" || command === "--help") return help();
  if (command === "run") {
    const workflow = args.shift();
    if (!workflow) throw new Error("usage: codex-workflow run <workflow.js> [--cwd <path>]");
    const opts = parseOpts(args);
    if (opts.serve !== false) opts.onStateReady = state => startDashboard(state, opts);
    const state = await createRun(workflow, opts);
    console.log(formatSummary(state));
    return;
  }
  if (command === "resume") {
    const runId = args.shift();
    if (!runId) throw new Error("usage: codex-workflow resume <run-id> [--cwd <path>]");
    const opts = parseOpts(args);
    const state = await resumeRun(path.resolve(opts.cwd ?? process.cwd()), runId, opts);
    console.log(formatSummary(state));
    return;
  }
  if (command === "pause") {
    const runId = args.shift();
    if (!runId) throw new Error("usage: codex-workflow pause <run-id> [--cwd <path>]");
    const opts = parseOpts(args);
    const state = await requestPause(path.resolve(opts.cwd ?? process.cwd()), runId);
    console.log(formatSummary(state));
    return;
  }
  if (command === "stop-agent") {
    const runId = args.shift();
    const agentId = args.shift();
    if (!runId || !agentId) throw new Error("usage: codex-workflow stop-agent <run-id> <agent-id> [--cwd <path>]");
    const opts = parseOpts(args);
    const state = await stopAgent(path.resolve(opts.cwd ?? process.cwd()), runId, agentId);
    console.log(formatSummary(state));
    return;
  }
  if (command === "rerun-agent") {
    const runId = args.shift();
    const agentId = args.shift();
    if (!runId || !agentId) throw new Error("usage: codex-workflow rerun-agent <run-id> <agent-id> [--cwd <path>]");
    const opts = parseOpts(args);
    const state = await rerunAgent(path.resolve(opts.cwd ?? process.cwd()), runId, agentId, opts);
    console.log(formatSummary(state));
    return;
  }
  if (command === "status") {
    const runId = args.shift();
    if (!runId) throw new Error("usage: codex-workflow status <run-id> [--cwd <path>]");
    const opts = parseOpts(args);
    console.log(formatSummary(await readState(path.resolve(opts.cwd ?? process.cwd()), runId)));
    return;
  }
  if (command === "serve") {
    const runId = args.shift();
    if (!runId) throw new Error("usage: codex-workflow serve <run-id> [--cwd <path>] [--port <port>] [--no-open]");
    const opts = parseOpts(args);
    await serve(path.resolve(opts.cwd ?? process.cwd()), runId, opts.port ? Number(opts.port) : undefined, {
      open: opts.open !== false,
      portExplicit: Boolean(opts.port),
      exitOnDone: opts.exitOnDone === "true",
    });
    return;
  }
  if (command === "list") {
    const opts = parseOpts(args);
    const dir = runsDir(path.resolve(opts.cwd ?? process.cwd()));
    try {
      const entries = await readdir(dir);
      for (const id of entries) console.log(id);
    } catch {
      console.log("No workflow runs found.");
    }
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

function parseOpts(values) {
  const opts = {};
  for (let i = 0; i < values.length; i += 1) {
    const key = values[i];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    if (key.startsWith("--no-")) {
      opts[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = false;
      continue;
    }
    opts[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = values[++i];
  }
  return opts;
}

function help() {
  console.log(`codex-workflow

Commands:
  run <workflow.js> [--cwd <path>] [--concurrency <n>] [--model <model>] [--worktree auto|always|never] [--no-serve] [--no-open]
  status <run-id> [--cwd <path>]
  serve <run-id> [--cwd <path>] [--port <port>] [--no-open]
  pause <run-id> [--cwd <path>]
  resume <run-id> [--cwd <path>]
  stop-agent <run-id> <agent-id> [--cwd <path>]
  rerun-agent <run-id> <agent-id> [--cwd <path>]
  list [--cwd <path>]`);
}

function startDashboard(state, opts) {
  const cli = fileURLToPath(import.meta.url);
  const args = [cli, "serve", state.run_id, "--cwd", state.cwd];
  if (opts.port) args.push("--port", String(opts.port));
  if (opts.open === false) args.push("--no-open");
  args.push("--exit-on-done", "true");
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  child.unref();
  return new Promise(resolve => {
    let output = "";
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      const match = output.match(/Codex workflow dashboard: (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) console.log(`Codex workflow dashboard: ${match[1]}`);
      child.stdout.destroy();
      resolve();
    };
    child.stdout.on("data", chunk => {
      output += chunk;
      if (output.includes("Codex workflow dashboard:")) done();
    });
    child.on("error", done);
    child.on("exit", done);
    setTimeout(done, 2000).unref();
  });
}
