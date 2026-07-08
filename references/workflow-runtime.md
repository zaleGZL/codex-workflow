# Codex Workflow Runtime

Use a workflow for large fan-out work: codebase audits, broad migrations, cross-checked research, or tasks that split cleanly across files. Use normal Codex work for small edits or one-file fixes.

## Script Shape

Prefer this form:

```js
export const meta = {
  name: "audit-routes",
  description: "Audit route files",
};

export default async ({ agent, pipeline }) => {
  const files = ["src/a.ts", "src/b.ts"];
  const results = await pipeline(files, file =>
    agent(`Audit ${file}`, { label: file, mode: "read" })
  );
  return results;
};
```

Top-level `await agent(...)` also works, but only `export default async` can return an overall result.

Generated workflow files should live outside the target repository:

```text
~/.codex/codex-workflow/workflows/
```

## API

`agent(prompt, options)` runs one `codex exec` worker.

Workers run with `codex exec --json --output-last-message <result.md> --cd <workdir> --sandbox danger-full-access -`.

Options:

- `label`: display name in status and dashboard.
- `mode`: `"read"` or `"edit"`, default `"read"`.
- `files`: files the edit agent is expected to modify.
- `cwd`: per-agent working directory.
- `model`: Codex model override.
- `schema`: JSON schema file passed to Codex.
- `worktree`: `"auto"`, `"always"`, or `"never"`.

`pipeline(items, worker, options)` runs agents over a list.

Options:

- `concurrency`: default `4`.
- `label`: phase name in state.

Pipeline results stay ordered by input item. Failed agents are returned as failures; other items continue.

`verify(command, options)` runs a local shell command after or between agent work.

Options:

- `label`: display name in state.
- `cwd`: command working directory, default workflow cwd.

It returns `{ status, label, command, cwd, exit_code, stdout, stderr }`. Non-zero exits return `status: "failed"` instead of throwing, so the workflow decides whether to continue.

`review(prompt, options)` runs `codex review --uncommitted`.

Options:

- `label`: display name in state.
- `cwd`: review working directory, default workflow cwd.
- `base`: branch passed to `codex review --base`.
- `commit`: commit passed to `codex review --commit`.

It returns `{ status, label, cwd, exit_code, result, stderr }`.

## Worktree Strategy

Explicit `worktree` wins. Otherwise `auto` is used:

- read agents never use worktrees.
- edit agents with non-overlapping `files` run in the original repo.
- edit agents with overlapping `files`, or missing `files`, use one git worktree per agent.

If `worktree: "never"` conflicts with overlapping files, the run continues and the agent gets a warning.

## Pause And Resume

`pause <run-id>` requests a graceful pause. Running agents finish; no new pending agents start. When running agents are done, the run becomes `paused`.

`resume <run-id>` reloads the saved workflow and state. Done agents are reused. Pending agents run. Stale running agents from an interrupted process are rerun.

`stop-agent <run-id> <agent-id>` requests a running agent stop. The agent keeps its `pid` in state and ends as `stopped` when the child process exits.

`rerun-agent <run-id> <agent-id>` reruns one terminal agent (`done`, `failed`, `stopped`, or `stale`) when the run is `done`, `failed`, or `paused`. It marks that agent stale and resumes the saved workflow.

## Dashboard

`run` starts a dashboard server immediately and opens it in the default browser. Reopen an existing run with:

```bash
node scripts/cli.mjs serve <run-id>
```

Pass `--no-open` when running in a headless environment.
It prefers port `8765` and falls back to the next free port unless `--port` was explicitly provided.

## State

Runtime files are stored outside target repositories:

```text
~/.codex/codex-workflow/runs/<run-id>/
~/.codex/codex-workflow/worktrees/<run-id>/<agent-id>/
```

Routes:

- `/`: dashboard.
- `/state.json`: raw state.
- `/agents/<id>`: agent detail.
- `/agents/<id>/events`: raw Codex JSONL events.
- `POST /agents/<id>/stop`: stop one running agent.
- `POST /agents/<id>/rerun`: rerun one terminal agent.
- `POST /pause`: request pause.
- `POST /resume`: continue.

`state.json` also includes `steps`, which records non-agent helper calls such as `verify` and `review`.

## Limits

V1 does not auto-merge edit branches, rerun individual agents while the run is still running, or guarantee conflict-free edits when `worktree: "never"` is forced.
