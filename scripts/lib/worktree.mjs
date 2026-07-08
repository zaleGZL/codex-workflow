import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export function hasOverlappingFiles(jobs) {
  const seen = new Set();
  for (const job of jobs) {
    if (job.mode !== "edit") continue;
    if (!Array.isArray(job.files) || job.files.length === 0) return true;
    for (const file of job.files) {
      const normalized = path.normalize(file);
      if (seen.has(normalized)) return true;
      seen.add(normalized);
    }
  }
  return false;
}

export function shouldUseWorktree(agent, parallelJobs, globalPolicy = "auto") {
  const policy = agent.worktree ?? globalPolicy;
  if (agent.mode !== "edit") return { useWorktree: false, warning: null };
  if (policy === "always") return { useWorktree: true, warning: null };
  const overlap = hasOverlappingFiles(parallelJobs);
  if (policy === "never") {
    return {
      useWorktree: false,
      warning: overlap ? "worktree disabled but parallel edit jobs overlap or omit files" : null,
    };
  }
  return { useWorktree: overlap, warning: null };
}

export function worktreeInfo(cwd, runId, agentId) {
  return {
    worktree: path.join(cwd, ".codex", "workflow-worktrees", runId, agentId),
    branch: `codex/workflow/${runId}/${agentId}`,
  };
}

export async function isGitRepo(cwd) {
  const result = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return result.code === 0 && result.stdout.trim() === "true";
}

export async function createWorktree(cwd, runId, agentId) {
  const info = worktreeInfo(cwd, runId, agentId);
  await mkdir(path.dirname(info.worktree), { recursive: true });
  const result = await runGit(cwd, ["worktree", "add", "-B", info.branch, info.worktree, "HEAD"]);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "git worktree add failed");
  return info;
}

function runGit(cwd, args) {
  return new Promise(resolve => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.on("error", error => resolve({ code: 1, stdout, stderr: error.message }));
    child.on("exit", code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
