import { pathToFileURL } from "node:url";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureCodexInstalled, runCodexAgent } from "./codex.mjs";
import { readState, runDir, statePath, writeJsonAtomic, writeState } from "./state.mjs";
import { createWorktree, isGitRepo, shouldUseWorktree } from "./worktree.mjs";

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

async function runWorkflow(cwd, runId, opts) {
  const state = await readState(cwd, runId);
  const runtime = new Runtime(cwd, runId, opts);
  globalThis.agent = runtime.agent.bind(runtime);
  globalThis.pipeline = runtime.pipeline.bind(runtime);
  try {
    const workflow = await import(`${pathToFileURL(state.workflow_path).href}?run=${Date.now()}`);
    const withMeta = await readState(cwd, runId);
    if (workflow.meta?.name) withMeta.name = workflow.meta.name;
    if (workflow.meta?.description) withMeta.description = workflow.meta.description;
    await writeState(cwd, withMeta);
    let result = null;
    if (typeof workflow.default === "function") {
      result = await workflow.default({ agent: globalThis.agent, pipeline: globalThis.pipeline });
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

  nextAgentId() {
    return `agent-${String(++this.agentSeq).padStart(3, "0")}`;
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
      phase.status = phase.agents_done + phase.agents_failed >= phase.agents_total ? "done" : "running";
    });
  }

  async runOrReuse(job, parallelJobs) {
    let state = await readState(this.cwd, this.runId);
    const existing = state.agents.find(a => a.id === job.id);
    if (existing?.status === "done") return readAgentResult(existing);
    if (existing?.status === "failed") return readAgentResult(existing);
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
    const result = await runCodexAgent(agent, workdir);
    const finalAgent = {
      ...agent,
      status: result.exitCode === 0 ? "done" : "failed",
      exit_code: result.exitCode,
      error: result.error,
      ended_at: new Date().toISOString(),
    };
    await this.upsertAgent(finalAgent);
    return result.exitCode === 0
      ? readAgentResult(finalAgent)
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

  async mutateState(mutator) {
    this.stateQueue = this.stateQueue.then(async () => {
      const state = await readState(this.cwd, this.runId);
      await mutator(state);
      await writeState(this.cwd, state);
    });
    return this.stateQueue;
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
