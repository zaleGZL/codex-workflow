import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function buildCodexArgs(agent, workdir) {
  const args = [
    "exec",
    "--json",
    "--output-last-message",
    agent.result_path,
    "--cd",
    workdir,
    "--sandbox",
    "danger-full-access",
  ];
  if (agent.model) args.push("--model", agent.model);
  if (agent.schema) args.push("--output-schema", agent.schema);
  args.push("-");
  return args;
}

export async function ensureCodexInstalled() {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["--version"], { stdio: "ignore" });
    child.on("error", () => {
      reject(new Error("Codex CLI is not installed or not on PATH. Install Codex CLI, then rerun this workflow."));
    });
    child.on("exit", code => {
      if (code === 0) resolve();
      else reject(new Error("Codex CLI check failed. Install or repair Codex CLI, then rerun this workflow."));
    });
  });
}

export async function runCodexAgent(agent, workdir, options = {}) {
  await mkdir(path.dirname(agent.prompt_path), { recursive: true });
  await writeFile(agent.prompt_path, agent.prompt);
  await mkdir(path.dirname(agent.events_path), { recursive: true });

  return new Promise(resolve => {
    const child = spawn("codex", buildCodexArgs(agent, workdir), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    options.onPid?.(child.pid);
    const events = createWriteStream(agent.events_path, { flags: "a" });
    let stdoutBuffer = "";
    let usage = null;
    child.stdout.on("data", chunk => {
      const text = chunk.toString();
      events.write(text);
      stdoutBuffer += text;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const next = extractUsage(line);
        if (next) {
          usage = next;
          options.onUsage?.(next);
        }
      }
    });
    child.stderr.on("data", chunk => events.write(JSON.stringify({ type: "stderr", text: chunk.toString() }) + "\n"));
    child.stdin.end(agent.prompt);
    child.on("error", error => {
      events.write(JSON.stringify({ type: "error", text: error.message }) + "\n");
      events.end();
      resolve({ exitCode: 127, error: error.message });
    });
    child.on("exit", (code, signal) => {
      const next = extractUsage(stdoutBuffer);
      if (next) {
        usage = next;
        options.onUsage?.(next);
      }
      events.end();
      resolve({ exitCode: code ?? 1, signal, usage });
    });
  });
}

export function runCommand(command, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.on("error", error => resolve({ exitCode: 127, stdout, stderr: stderr + error.message }));
    child.on("exit", code => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
}

export function buildReviewCommand(options = {}) {
  const args = ["codex", "review", "--uncommitted"];
  if (options.base) args.push("--base", shellArg(options.base));
  if (options.commit) args.push("--commit", shellArg(options.commit));
  if (options.prompt) args.push("-");
  return args.join(" ");
}

function shellArg(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function extractUsage(line) {
  if (!line.trim()) return null;
  try {
    const event = JSON.parse(line);
    return normalizeUsage(event.usage ?? event.item?.usage);
  } catch {
    return null;
  }
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const normalized = {
    input_tokens: numberOrZero(usage.input_tokens),
    cached_input_tokens: numberOrZero(usage.cached_input_tokens),
    output_tokens: numberOrZero(usage.output_tokens),
    reasoning_output_tokens: numberOrZero(usage.reasoning_output_tokens),
  };
  normalized.total_tokens = numberOrZero(usage.total_tokens)
    || normalized.input_tokens + normalized.output_tokens;
  return normalized;
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}
