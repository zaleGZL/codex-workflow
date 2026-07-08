---
name: codex-workflow
description: Create, run, and monitor Codex CLI workflows that fan out work to multiple codex exec subagents. Use when a task asks for workflow orchestration, parallel subagents, large audit/migration/research jobs, pause/resume workflow runs, or Codex CLI worker coordination.
---

# Codex Workflow

Use this skill when a task is too large or parallel for one Codex conversation.

The user should only describe the desired task in Codex. Do not ask the user to run the CLI unless they explicitly want manual control. Treat the CLI as this skill's internal runtime.

Before running a workflow:

1. Split the task into agent jobs.
2. For every edit job, declare the files it is expected to modify with `files`.
3. Write a workflow script using `agent()` and `pipeline()` under `~/.codex/codex-workflow/workflows/`, not inside the target repository.
4. Run it:

```bash
node scripts/cli.mjs run <workflow.js> --cwd <repo>
```

In the Codex app, pass `--no-open`, read the printed `Codex workflow dashboard: <url>` line, and open that URL in the in-app Browser when Browser is available. If Browser is unavailable, show the URL to the user as a link.

`run` starts the dashboard server immediately and prints its URL. Without `--no-open`, it also opens the default system browser. Use `serve` only when reopening an existing run.

Use `pause`, `resume`, `status`, and `list` from the same CLI for run control.

Read `references/workflow-runtime.md` before authoring non-trivial workflows, edit workflows, or workflows that need pause/resume behavior.
