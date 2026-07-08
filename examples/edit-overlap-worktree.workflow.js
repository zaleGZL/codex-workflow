export const meta = {
  name: "edit-overlap-worktree",
  description: "Edit overlapping files with worktrees in auto mode.",
};

export default async ({ agent, pipeline }) => {
  return pipeline(["pass-1", "pass-2"], label =>
    agent(`Update README.md for ${label}.`, {
      label,
      mode: "edit",
      files: ["README.md"],
    })
  );
};
