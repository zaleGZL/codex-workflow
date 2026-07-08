# Codex Workflow Skill

`codex-workflow` 是一个 Codex skill，也是一套本地 workflow runtime。它用 JavaScript workflow 脚本编排多个 `codex exec` sub agent，并行完成大型任务。

适用场景包括代码库审查、大规模迁移、交叉验证研究、并行代码修改等。它也提供本地 dashboard，用来看运行状态、暂停和继续。

[English README](README.md)

## 用户怎么使用

普通用户不需要手动执行 CLI。安装 skill 之后，在 Codex 输入框里点名这个 skill，并说明要完成的任务即可：

```text
Use codex-workflow to audit all route handlers for missing auth checks.
```

```text
使用 codex-workflow，把所有内部 fetch 调用迁移到 HttpClient wrapper。
```

```text
用 codex-workflow 研究这个仓库的架构，并总结高风险区域。
```

之后 Codex 会判断是否需要 workflow，生成 workflow 脚本，调用本地 runtime 执行，并给出 dashboard 地址查看进度。下面的 CLI 命令主要是给开发和调试用的实现细节。

## 环境要求

- Node.js 20+
- `codex` CLI 已安装并在 `PATH` 中
- 如果 edit agent 需要 worktree，则需要 Git

如果本机没有 `codex`，`run` 和 `resume` 会失败并提示安装。工具不会自动安装 Codex。

## 开发同步

把当前仓库同步到本机 Codex skills：

```bash
npm run sync:skill
```

监听文件变更并自动同步：

```bash
npm run dev
```

dev 同步不会删除运行状态。它只替换 `~/.codex/skills/codex-workflow` 下受管理的 skill 文件，并保留 `.codex/`、workflow runs 和其他运行时文件。

## 开发和调试用 CLI

运行 workflow：

```bash
node scripts/cli.mjs run examples/research-files.workflow.js --cwd .
```

查看状态：

```bash
node scripts/cli.mjs status <run-id> --cwd .
```

打开 dashboard：

```bash
node scripts/cli.mjs serve <run-id> --cwd . --port 8765
```

暂停和继续：

```bash
node scripts/cli.mjs pause <run-id> --cwd .
node scripts/cli.mjs resume <run-id> --cwd .
```

列出 runs：

```bash
node scripts/cli.mjs list --cwd .
```

## Workflow 脚本

推荐写法：

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

edit agent 应该声明预计修改的文件：

```js
agent("Update src/a.ts", {
  label: "src/a.ts",
  mode: "edit",
  files: ["src/a.ts"],
});
```

默认 worktree 策略是 `auto`：

- read agent 不使用 worktree
- edit agent 如果 `files` 不重叠，直接在原仓库运行
- edit agent 如果 `files` 重叠或缺失，使用每个 agent 独立的 worktree

完整 DSL 参考见 [references/workflow-runtime.md](references/workflow-runtime.md)。

## 状态文件

Workflow 状态保存在：

```text
.codex/workflow-runs/<run-id>/
```

Dashboard 和 CLI 都以 `state.json` 作为唯一事实源。

## 测试

```bash
npm test
```
