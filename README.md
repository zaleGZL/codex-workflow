# Codex Workflow Skill

`codex-workflow` is a Codex skill and local runtime for running JavaScript workflows that fan out work to multiple `codex exec` subagents.

It is built for large tasks such as codebase audits, migrations, cross-checked research, and parallel edit jobs. It also includes a local dashboard for workflow status, graceful pause, and resume.

[中文说明](README.zh-CN.md)

## User Usage

End users do not need to run the CLI directly. After the skill is installed, use it from the Codex input box by naming the skill and describing the task:

```text
Use codex-workflow to audit all route handlers for missing auth checks.
```

```text
Use codex-workflow to migrate all internal fetch calls to the HttpClient wrapper.
```

```text
Use codex-workflow to research the architecture of this repo and summarize the risky areas.
```

Codex decides whether a workflow is useful, writes the workflow script under `~/.codex/codex-workflow/workflows/`, runs the local runtime, and opens the dashboard in your browser. The CLI commands below are for development and debugging.

## Requirements

- Node.js 20+
- Codex CLI on `PATH`
- Git, when edit agents need worktrees

If `codex` is missing, `run` and `resume` fail with an install prompt. The tool does not install Codex automatically.

## Development Sync

Install/sync this repo into local Codex skills:

```bash
npm run sync:skill
```

Watch and resync on file changes:

```bash
npm run dev
```

The dev sync preserves runtime state. It only replaces managed skill files in `~/.codex/skills/codex-workflow`. Runtime files live under `~/.codex/codex-workflow/`.

## CLI For Development And Debugging

Run a workflow:

```bash
node scripts/cli.mjs run examples/research-files.workflow.js --cwd .
```

`run` starts the dashboard server immediately and opens it in your browser. It prefers port `8765` and falls back to the next free port when multiple dashboards are running.

Show status:

```bash
node scripts/cli.mjs status <run-id> --cwd .
```

Open the dashboard:

```bash
node scripts/cli.mjs serve <run-id> --cwd . --port 8765
```

`serve` reopens an existing run dashboard in your browser. Use `--no-open` for headless or test runs.
By default it prefers port `8765` and automatically falls back to the next free port when multiple dashboards are running. If you pass `--port`, that port is treated as explicit and a conflict fails fast.

Pause and resume:

```bash
node scripts/cli.mjs pause <run-id> --cwd .
node scripts/cli.mjs resume <run-id> --cwd .
```

Stop or rerun one agent:

```bash
node scripts/cli.mjs stop-agent <run-id> <agent-id> --cwd .
node scripts/cli.mjs rerun-agent <run-id> <agent-id> --cwd .
```

List runs:

```bash
node scripts/cli.mjs list --cwd .
```

## Workflow Script

Recommended shape:

```js
export const meta = {
  name: "audit-routes",
  description: "Audit route files",
};

export default async ({ agent, pipeline }) => {
  const files = ["src/a.ts", "src/b.ts"];

  return pipeline(files, file =>
    agent(`Audit ${file}`, {
      label: file,
      mode: "read",
    })
  );
};
```

Edit agents should declare expected files:

```js
agent("Update src/a.ts", {
  label: "src/a.ts",
  mode: "edit",
  files: ["src/a.ts"],
});
```

Edit workflows can close with applying changes, checks, and review:

```js
export default async ({ agent, applyEdits, verify, review }) => {
  await agent("Update src/a.ts", {
    label: "src/a.ts",
    mode: "edit",
    files: ["src/a.ts"],
  });

  const applied = await applyEdits({ label: "apply edits" });
  if (applied.status === "failed") return { applied };

  const tests = await verify("npm test", { label: "tests" });
  const findings = await review("Review the uncommitted workflow changes.", { label: "review" });
  return { applied, tests, findings };
};
```

Workflow hooks run deterministic local commands at lifecycle points:

```js
export const hooks = {
  beforeRun: [{ command: "npm test", label: "preflight" }],
  beforeAgent: [{ command: "node scripts/inject-context.mjs", inject: "prompt" }],
  afterAgent: [{ command: "npm run lint", onFailure: "warn" }],
  afterRun: [{ command: "node scripts/notify.mjs", onFailure: "warn" }],
};
```

Hooks receive a JSON payload on stdin with the run id, cwd, event, state path, bus path, and agent/result when relevant. Non-zero exits block by default; `onFailure: "warn"` records a warning step and continues. A `beforeAgent` hook can print JSON like `{ "context": "extra instructions" }` when `inject: "prompt"` is set.

Workflows can also share run-local tasks, messages, and context across one-shot agents:

```js
export default async ({ agent, task, message, context }) => {
  await task("Check auth middleware");
  await message("routes", "Focus on admin-only endpoints");
  await context("The app uses src/lib/auth.ts for policy checks");

  return agent("Audit route handlers", { label: "routes" });
};
```

Each spawned agent receives a short `Workflow shared context` block with open tasks, messages addressed to its label/id, and latest context items.

The default worktree policy is `auto`:

- read agents never use worktrees
- edit agents with non-overlapping `files` run in the original repo
- edit agents with overlapping or missing `files` use per-agent worktrees

For the full DSL reference, read [references/workflow-runtime.md](references/workflow-runtime.md).

## State

Workflow state is stored under:

```text
~/.codex/codex-workflow/runs/<run-id>/
```

The dashboard and CLI both read `state.json` as the source of truth.
The shared workflow bus is stored next to it as `bus.json`.

Generated workflow source files should be kept under:

```text
~/.codex/codex-workflow/workflows/
```

## Tests

```bash
npm test
```
