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
    agent.mode === "edit" ? "workspace-write" : "read-only",
    "--ask-for-approval",
    "never",
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

export async function runCodexAgent(agent, workdir) {
  await mkdir(path.dirname(agent.prompt_path), { recursive: true });
  await writeFile(agent.prompt_path, agent.prompt);
  await mkdir(path.dirname(agent.events_path), { recursive: true });

  return new Promise(resolve => {
    const child = spawn("codex", buildCodexArgs(agent, workdir), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events = createWriteStream(agent.events_path, { flags: "a" });
    child.stdout.pipe(events);
    child.stderr.on("data", chunk => events.write(JSON.stringify({ type: "stderr", text: chunk.toString() }) + "\n"));
    child.stdin.end(agent.prompt);
    child.on("error", error => {
      events.write(JSON.stringify({ type: "error", text: error.message }) + "\n");
      events.end();
      resolve({ exitCode: 127, error: error.message });
    });
    child.on("exit", code => {
      events.end();
      resolve({ exitCode: code ?? 1 });
    });
  });
}
