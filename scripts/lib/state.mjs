import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function runsDir(cwd) {
  return path.join(cwd, ".codex", "workflow-runs");
}

export function runDir(cwd, runId) {
  return path.join(runsDir(cwd), runId);
}

export function statePath(cwd, runId) {
  return path.join(runDir(cwd, runId), "state.json");
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, file);
}

export async function readState(cwd, runId) {
  return readJson(statePath(cwd, runId));
}

export async function writeState(cwd, state) {
  state.counts = countAgents(state.agents);
  await writeJsonAtomic(statePath(cwd, state.run_id), state);
}

export function countAgents(agents = []) {
  const counts = { pending: 0, running: 0, done: 0, failed: 0, stale: 0 };
  for (const agent of agents) {
    if (counts[agent.status] !== undefined) counts[agent.status] += 1;
  }
  return counts;
}

export function formatSummary(state) {
  const c = countAgents(state.agents);
  return [
    `${state.name} ${state.status}  done:${c.done} failed:${c.failed} running:${c.running} pending:${c.pending} stale:${c.stale}`,
    `run_id: ${state.run_id}`,
    `cwd: ${state.cwd}`,
  ].join("\n");
}
