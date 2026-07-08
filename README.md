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

Codex decides whether a workflow is useful, generates the workflow script, runs the local runtime, and shows the dashboard URL for progress. The CLI commands below are for development and debugging.

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

The dev sync preserves runtime state. It only replaces managed skill files in `~/.codex/skills/codex-workflow` and keeps `.codex/`, workflow runs, and other runtime files.

## CLI For Development And Debugging

Run a workflow:

```bash
node scripts/cli.mjs run examples/research-files.workflow.js --cwd .
```

Show status:

```bash
node scripts/cli.mjs status <run-id> --cwd .
```

Open the dashboard:

```bash
node scripts/cli.mjs serve <run-id> --cwd . --port 8765
```

`serve` opens the dashboard in your browser automatically. Use `--no-open` for headless or test runs.
By default it prefers port `8765` and automatically falls back to the next free port when multiple dashboards are running. If you pass `--port`, that port is treated as explicit and a conflict fails fast.

Pause and resume:

```bash
node scripts/cli.mjs pause <run-id> --cwd .
node scripts/cli.mjs resume <run-id> --cwd .
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

The default worktree policy is `auto`:

- read agents never use worktrees
- edit agents with non-overlapping `files` run in the original repo
- edit agents with overlapping or missing `files` use per-agent worktrees

For the full DSL reference, read [references/workflow-runtime.md](references/workflow-runtime.md).

## State

Workflow state is stored under:

```text
.codex/workflow-runs/<run-id>/
```

The dashboard and CLI both read `state.json` as the source of truth.

## Tests

```bash
npm test
```
