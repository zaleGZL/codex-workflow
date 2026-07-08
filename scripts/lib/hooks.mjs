import { spawn } from "node:child_process";

export async function runHooks(event, handlers = [], payload = {}, options = {}) {
  const results = [];
  const contexts = [];
  for (const handler of handlers) {
    if (!handler?.command) continue;
    const result = await runHookCommand(handler, payload, options);
    results.push(result);
    if (result.context && event === "beforeAgent" && handler.inject === "prompt" && result.status !== "failed") {
      contexts.push(result.context);
    }
    if (result.status === "failed") {
      return {
        status: "failed",
        blocked: true,
        reason: result.reason || `hook failed: ${result.label}`,
        results,
        context: contexts.join("\n\n"),
      };
    }
  }
  return {
    status: results.some(result => result.status === "warning") ? "warning" : "done",
    blocked: false,
    results,
    context: contexts.join("\n\n"),
  };
}

export function parseHookOutput(stdout) {
  const text = stdout.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function runHookCommand(handler, payload, options = {}) {
  const command = handler.command;
  const timeoutMs = normalizeTimeout(handler.timeout ?? options.timeout ?? 300000);
  const onFailure = handler.onFailure ?? options.defaultOnFailure ?? "block";
  return new Promise(resolve => {
    const startedAt = new Date().toISOString();
    const child = spawn(command, {
      cwd: options.cwd ?? payload.cwd,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try {
            child.kill("SIGTERM");
          } catch {}
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {}
          }, 250).unref();
        }, timeoutMs)
      : null;
    timer?.unref();
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.stdin.end(`${JSON.stringify(payload)}\n`);
    child.on("error", error => {
      if (timer) clearTimeout(timer);
      resolve(toHookResult(handler, {
        command,
        exitCode: 127,
        stdout,
        stderr: stderr + error.message,
        timedOut,
        onFailure,
        startedAt,
      }));
    });
    child.on("exit", code => {
      if (timer) clearTimeout(timer);
      resolve(toHookResult(handler, {
        command,
        exitCode: timedOut ? 124 : code ?? 1,
        stdout,
        stderr,
        timedOut,
        onFailure,
        startedAt,
      }));
    });
  });
}

function toHookResult(handler, result) {
  const parsed = parseHookOutput(result.stdout);
  const failed = result.exitCode !== 0 || parsed.ok === false;
  const warning = failed && result.onFailure === "warn";
  const reason = result.timedOut
    ? "hook timed out"
    : parsed.reason || (result.exitCode === 0 ? "" : `hook exited ${result.exitCode}`);
  return {
    label: handler.label ?? handler.command,
    command: result.command,
    status: failed ? warning ? "warning" : "failed" : "done",
    exit_code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    reason,
    context: typeof parsed.context === "string" ? parsed.context : "",
    timed_out: result.timedOut,
    started_at: result.startedAt,
    ended_at: new Date().toISOString(),
  };
}

function normalizeTimeout(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 1000 ? Math.ceil(number * 1000) : Math.ceil(number);
}
