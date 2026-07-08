import { pathToFileURL } from "node:url";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildReviewCommand, ensureCodexInstalled, runCodexAgent, runCommand } from "./codex.mjs";
import { readState, runDir, statePath, writeJsonAtomic, writeState } from "./state.mjs";
import { applyPatch, createWorktree, diffWorktree, isGitRepo, shouldUseWorktree } from "./worktree.mjs";

export function makeRunId(name = "workflow") {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const safe = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "workflow";
  return `${stamp}-${safe}`;
}

export async function createRun(workflowFile, opts = {}) {
  await ensureCodexInstalled();
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const source = path.resolve(workflowFile);
  const name = path.basename(source, path.extname(source));
  const runId = opts.runId ?? makeRunId(name);
  const dir = runDir(cwd, runId);
  await mkdir(dir, { recursive: true });
  const savedWorkflow = path.join(dir, "workflow.js");
  await copyFile(source, savedWorkflow);
  const state = {
    run_id: runId,
    name,
    description: "",
    cwd,
    workflow_path: savedWorkflow,
    status: "running",
    pause_requested: false,
    started_at: new Date().toISOString(),
    ended_at: null,
    phases: [],
    agents: [],
    steps: [],
    result: null,
    counts: {},
  };
  await writeState(cwd, state);
  if (typeof opts.onStateReady === "function") await opts.onStateReady(state);
  return runWorkflow(cwd, runId, opts);
}

export async function resumeRun(cwd, runId, opts = {}) {
  await ensureCodexInstalled();
  const state = await readState(cwd, runId);
  for (const agent of state.agents) {
    if (agent.status === "running") agent.status = "stale";
  }
  state.status = "running";
  state.pause_requested = false;
  state.resumed_at = new Date().toISOString();
  await writeState(cwd, state);
  return runWorkflow(cwd, runId, opts);
}

export async function requestPause(cwd, runId) {
  const state = await readState(cwd, runId);
  state.pause_requested = true;
  if (state.status === "pending") state.status = "paused";
  await writeState(cwd, state);
  return state;
}

export async function clearPause(cwd, runId) {
  const state = await readState(cwd, runId);
  state.pause_requested = false;
  if (state.status === "paused") state.status = "running";
  await writeState(cwd, state);
  return state;
}

export async function stopAgent(cwd, runId, agentId) {
  const state = await readState(cwd, runId);
  const agent = state.agents.find(a => a.id === agentId);
  if (!agent) throw new Error(`agent not found: ${agentId}`);
  if (agent.status !== "running") throw new Error(`agent is not running: ${agentId}`);
  if (!agent.pid) throw new Error(`agent has no pid: ${agentId}`);
  agent.stop_requested = true;
  agent.stop_requested_at = new Date().toISOString();
  await writeState(cwd, state);
  if (!processExists(agent.pid)) return markAgentStopped(cwd, runId, agentId);
  try {
    process.kill(agent.pid, "SIGTERM");
  } catch {
    return markAgentStopped(cwd, runId, agentId);
  }
  setTimeout(() => {
    if (processExists(agent.pid)) {
      try {
        process.kill(agent.pid, "SIGKILL");
      } catch {}
    }
  }, 500).unref();
  return readState(cwd, runId);
}

export async function rerunAgent(cwd, runId, agentId, opts = {}) {
  const state = await readState(cwd, runId);
  const agent = state.agents.find(a => a.id === agentId);
  if (!agent) throw new Error(`agent not found: ${agentId}`);
  if (!["done", "failed", "stopped", "stale"].includes(agent.status)) {
    throw new Error(`agent cannot be rerun from status ${agent.status}: ${agentId}`);
  }
  if (!["done", "failed", "paused"].includes(state.status)) {
    throw new Error(`run must be done, failed, or paused to rerun an agent: ${runId}`);
  }
  agent.status = "stale";
  agent.rerun_requested_at = new Date().toISOString();
  delete agent.pid;
  delete agent.exit_code;
  delete agent.signal;
  delete agent.ended_at;
  delete agent.error;
  delete agent.stop_requested;
  delete agent.stop_requested_at;
  await writeState(cwd, state);
  return resumeRun(cwd, runId, opts);
}

async function runWorkflow(cwd, runId, opts) {
  const state = await readState(cwd, runId);
  const runtime = new Runtime(cwd, runId, opts);
  globalThis.agent = runtime.agent.bind(runtime);
  globalThis.pipeline = runtime.pipeline.bind(runtime);
  globalThis.verify = runtime.verify.bind(runtime);
  globalThis.review = runtime.review.bind(runtime);
  globalThis.applyEdits = runtime.applyEdits.bind(runtime);
  try {
    const workflow = await import(`${pathToFileURL(state.workflow_path).href}?run=${Date.now()}`);
    const withMeta = await readState(cwd, runId);
    if (workflow.meta?.name) withMeta.name = workflow.meta.name;
    if (workflow.meta?.description) withMeta.description = workflow.meta.description;
    await writeState(cwd, withMeta);
    let result = null;
    if (typeof workflow.default === "function") {
      result = await workflow.default({
        agent: globalThis.agent,
        pipeline: globalThis.pipeline,
        verify: globalThis.verify,
        review: globalThis.review,
        applyEdits: globalThis.applyEdits,
      });
    }
    const latest = await readState(cwd, runId);
    latest.result = result;
    if (latest.pause_requested && hasPending(latest)) latest.status = "paused";
    else latest.status = latest.agents.some(a => a.status === "failed") ? "failed" : "done";
    latest.ended_at = new Date().toISOString();
    await writeState(cwd, latest);
    return latest;
  } catch (error) {
    const latest = await readState(cwd, runId);
    if (latest.pause_requested && hasPending(latest)) latest.status = "paused";
    else latest.status = "failed";
    latest.error = error.message;
    latest.ended_at = new Date().toISOString();
    await writeState(cwd, latest);
    if (latest.status !== "paused") throw error;
    return latest;
  } finally {
    delete globalThis.agent;
    delete globalThis.pipeline;
    delete globalThis.verify;
    delete globalThis.review;
    delete globalThis.applyEdits;
  }
}

function hasPending(state) {
  return state.agents.some(a => a.status === "pending" || a.status === "stale");
}

class Runtime {
  constructor(cwd, runId, opts) {
    this.cwd = cwd;
    this.runId = runId;
    this.defaultConcurrency = Number(opts.concurrency ?? 4);
    this.defaultModel = opts.model;
    this.globalWorktree = opts.worktree ?? "auto";
    this.agentSeq = 0;
    this.pipelineSeq = 0;
    this.stepSeq = 0;
    this.captureId = null;
    this.capturedCall = null;
    this.stateQueue = Promise.resolve();
  }

  async agent(prompt, options = {}) {
    if (this.captureId) {
      this.capturedCall = { prompt, options };
      return { __capturedAgent: true, id: this.captureId };
    }
    const id = this.nextAgentId();
    const job = normalizeJob(id, prompt, options, this);
    return this.runOrReuse(job, [job]);
  }

  async pipeline(items, worker, options = {}) {
    const pipelineId = `pipeline-${String(++this.pipelineSeq).padStart(3, "0")}`;
    const concurrency = Number(options.concurrency ?? this.defaultConcurrency);
    const jobs = [];
    for (let index = 0; index < items.length; index += 1) {
      const id = `${pipelineId}-${String(index + 1).padStart(3, "0")}`;
      const captured = await this.captureAgentCall(id, items[index], worker);
      jobs.push(normalizeJob(id, captured.prompt, captured.options, this));
    }
    await this.upsertPhase(pipelineId, options.label ?? pipelineId, jobs.length);
    for (const job of jobs) await this.upsertAgent(job);
    const results = new Array(jobs.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (next < jobs.length) {
        if (await this.isPauseRequested()) break;
        const index = next++;
        results[index] = await this.runOrReuse(jobs[index], jobs);
        await this.updatePhase(pipelineId);
      }
    });
    await Promise.all(workers);
    if (await this.isPauseRequested() && results.some(v => v === undefined)) {
      throw new Error("workflow paused");
    }
    return results;
  }

  async verify(command, options = {}) {
    const cwd = path.resolve(options.cwd ?? this.cwd);
    const step = this.newStep("verify", options.label ?? command, { command, cwd });
    await this.upsertStep({ ...step, status: "running", started_at: new Date().toISOString() });
    const result = await runCommand(command, { cwd });
    const status = result.exitCode === 0 ? "done" : "failed";
    await this.upsertStep({
      ...step,
      status,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      ended_at: new Date().toISOString(),
    });
    return {
      status,
      label: step.label,
      command,
      cwd,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async review(prompt = "", options = {}) {
    const cwd = path.resolve(options.cwd ?? this.cwd);
    const command = buildReviewCommand({ ...options, prompt });
    const step = this.newStep("review", options.label ?? "codex review", { command, cwd });
    await this.upsertStep({ ...step, status: "running", started_at: new Date().toISOString() });
    const result = await runCommand(command, { cwd, input: prompt });
    const status = result.exitCode === 0 ? "done" : "failed";
    await this.upsertStep({
      ...step,
      status,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      ended_at: new Date().toISOString(),
    });
    return {
      status,
      label: step.label,
      cwd,
      exit_code: result.exitCode,
      result: result.stdout,
      stderr: result.stderr,
    };
  }

  async applyEdits(options = {}) {
    const label = options.label ?? "apply edits";
    const state = await readState(this.cwd, this.runId);
    const step = this.newStep("apply-edits", label, { cwd: this.cwd, agents: [] });
    await this.upsertStep({ ...step, status: "running", started_at: new Date().toISOString() });

    const results = [];
    for (const agent of state.agents.filter(a => a.mode === "edit")) {
      const base = pickAgent(agent);
      if (agent.status !== "done") {
        results.push({ ...base, status: "skipped", reason: `agent status is ${agent.status}` });
        continue;
      }
      if (!isWorktreePath(agent.worktree)) {
        results.push({ ...base, status: "skipped", reason: "agent edited workflow cwd directly" });
        continue;
      }
      const diff = await diffWorktree(agent.worktree);
      if (diff.code !== 0) {
        results.push({ ...base, status: "failed", stdout: diff.stdout, stderr: diff.stderr });
        continue;
      }
      if (!diff.stdout.trim()) {
        results.push({ ...base, status: "skipped", reason: "no diff" });
        continue;
      }
      const applied = await applyPatch(this.cwd, diff.stdout);
      results.push({
        ...base,
        status: applied.code === 0 ? "applied" : "failed",
        stdout: applied.stdout,
        stderr: applied.stderr,
      });
    }

    const summary = summarizeApply(label, results);
    await this.upsertStep({
      ...step,
      status: summary.status,
      agents: results,
      ended_at: new Date().toISOString(),
    });
    return summary;
  }

  nextAgentId() {
    return `agent-${String(++this.agentSeq).padStart(3, "0")}`;
  }

  newStep(type, label, extra) {
    return {
      id: `step-${String(++this.stepSeq).padStart(3, "0")}`,
      type,
      label,
      status: "pending",
      ...extra,
    };
  }

  async isPauseRequested() {
    return (await readState(this.cwd, this.runId)).pause_requested;
  }

  async upsertPhase(id, label, total) {
    await this.mutateState(state => {
      if (!state.phases.some(p => p.id === id)) {
        state.phases.push({ id, label, status: "running", agents_total: total, agents_done: 0, agents_failed: 0 });
      }
    });
  }

  async updatePhase(id) {
    await this.mutateState(state => {
      const phase = state.phases.find(p => p.id === id);
      if (!phase) return;
      const agents = state.agents.filter(a => a.id.startsWith(`${id}-`));
      phase.agents_done = agents.filter(a => a.status === "done").length;
      phase.agents_failed = agents.filter(a => a.status === "failed").length;
      phase.agents_stopped = agents.filter(a => a.status === "stopped").length;
      phase.status = phase.agents_done + phase.agents_failed + phase.agents_stopped >= phase.agents_total ? "done" : "running";
    });
  }

  async runOrReuse(job, parallelJobs) {
    let state = await readState(this.cwd, this.runId);
    const existing = state.agents.find(a => a.id === job.id);
    if (existing?.status === "done") return readAgentResult(existing);
    if (existing?.status === "failed") return readAgentResult(existing);
    if (existing?.status === "stopped") return readAgentResult(existing);
    if (state.pause_requested) {
      await this.upsertAgent({ ...job, status: "pending" });
      return { status: "pending", id: job.id };
    }

    const decision = shouldUseWorktree(job, parallelJobs, this.globalWorktree);
    const agent = { ...job, status: "running", started_at: new Date().toISOString(), warning: decision.warning };
    let workdir = agent.cwd;
    if (decision.useWorktree) {
      if (!(await isGitRepo(this.cwd))) {
        agent.status = "failed";
        agent.error = "worktree required but cwd is not a git repository";
        agent.ended_at = new Date().toISOString();
        await this.upsertAgent(agent);
        return { status: "failed", id: agent.id, error: agent.error };
      }
      try {
        const info = await createWorktree(this.cwd, this.runId, agent.id);
        agent.worktree = info.worktree;
        agent.branch = info.branch;
        workdir = info.worktree;
      } catch (error) {
        agent.status = "failed";
        agent.error = error.message;
        agent.ended_at = new Date().toISOString();
        await this.upsertAgent(agent);
        return { status: "failed", id: agent.id, error: agent.error };
      }
    }
    await this.upsertAgent(agent);
    const result = await runCodexAgent(agent, workdir, {
      onPid: pid => this.upsertAgent({ id: agent.id, pid }),
      onUsage: usage => this.updateAgentUsage(agent.id, usage),
    });
    const latestAgent = (await readState(this.cwd, this.runId)).agents.find(a => a.id === agent.id);
    const stopped = latestAgent?.stop_requested === true;
    const finalAgent = {
      ...agent,
      pid: latestAgent?.pid ?? agent.pid,
      stop_requested: latestAgent?.stop_requested,
      stop_requested_at: latestAgent?.stop_requested_at,
      status: stopped ? "stopped" : result.exitCode === 0 ? "done" : "failed",
      exit_code: result.exitCode,
      signal: result.signal,
      error: result.error,
      usage: result.usage ?? agent.usage,
      ended_at: new Date().toISOString(),
    };
    await this.upsertAgent(finalAgent);
    return result.exitCode === 0
      ? readAgentResult(finalAgent)
      : stopped
        ? { status: "stopped", id: finalAgent.id }
        : { status: "failed", id: finalAgent.id, error: result.error ?? `codex exited ${result.exitCode}` };
  }

  async captureAgentCall(id, item, worker) {
    this.captureId = id;
    this.capturedCall = null;
    try {
      await worker(item, id);
    } finally {
      this.captureId = null;
    }
    if (!this.capturedCall) throw new Error("pipeline worker must call agent(prompt, options)");
    return this.capturedCall;
  }

  async upsertAgent(agent) {
    await this.mutateState(state => {
      const index = state.agents.findIndex(a => a.id === agent.id);
      if (index === -1) state.agents.push(agent);
      else state.agents[index] = { ...state.agents[index], ...agent };
    });
  }

  async updateAgentUsage(id, usage) {
    await this.mutateState(state => {
      const agent = state.agents.find(a => a.id === id);
      if (agent) agent.usage = usage;
    });
  }

  async upsertStep(step) {
    await this.mutateState(state => {
      state.steps ??= [];
      const index = state.steps.findIndex(s => s.id === step.id);
      if (index === -1) state.steps.push(step);
      else state.steps[index] = { ...state.steps[index], ...step };
    });
  }

  async mutateState(mutator) {
    this.stateQueue = this.stateQueue.then(async () => {
      const state = await readState(this.cwd, this.runId);
      await mutator(state);
      await writeState(this.cwd, state);
    });
    return this.stateQueue;
  }
}

function isWorktreePath(value) {
  return typeof value === "string" && !["", "auto", "always", "never"].includes(value);
}

function pickAgent(agent) {
  return {
    id: agent.id,
    label: agent.label,
    worktree: agent.worktree,
    branch: agent.branch,
  };
}

function summarizeApply(label, results) {
  const applied = results.filter(r => r.status === "applied");
  const skipped = results.filter(r => r.status === "skipped");
  const failed = results.filter(r => r.status === "failed");
  return {
    status: failed.length ? "failed" : "done",
    label,
    applied,
    skipped,
    failed,
  };
}

async function markAgentStopped(cwd, runId, agentId) {
  const state = await readState(cwd, runId);
  const agent = state.agents.find(a => a.id === agentId);
  if (!agent) throw new Error(`agent not found: ${agentId}`);
  agent.status = "stopped";
  agent.ended_at = agent.ended_at ?? new Date().toISOString();
  await writeState(cwd, state);
  return state;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function normalizeJob(id, prompt, options, runtime) {
  const agentDir = path.join(runDir(runtime.cwd, runtime.runId), "agents", id);
  return {
    id,
    label: options.label ?? id,
    prompt: String(prompt),
    mode: options.mode ?? "read",
    files: options.files ?? [],
    cwd: path.resolve(options.cwd ?? runtime.cwd),
    model: options.model ?? runtime.defaultModel,
    schema: options.schema,
    worktree: options.worktree,
    prompt_path: path.join(agentDir, "prompt.md"),
    events_path: path.join(agentDir, "events.jsonl"),
    result_path: path.join(agentDir, "result.md"),
    status: "pending",
  };
}

async function readAgentResult(agent) {
  let text = "";
  try {
    text = await readFile(agent.result_path, "utf8");
  } catch {
    text = "";
  }
  return { status: agent.status, id: agent.id, label: agent.label, result: text, worktree: agent.worktree, branch: agent.branch };
}

export async function createFixtureState(cwd, runId, state) {
  await writeJsonAtomic(statePath(cwd, runId), state);
}
