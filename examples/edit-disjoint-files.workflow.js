export const meta = {
  name: "edit-disjoint-files",
  description: "Edit different files without worktrees in auto mode.",
};

export default async ({ agent, pipeline }) => {
  return pipeline(["docs/a.md", "docs/b.md"], file =>
    agent(`Make the requested change in ${file}.`, {
      label: file,
      mode: "edit",
      files: [file],
    })
  );
};
