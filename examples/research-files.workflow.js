export const meta = {
  name: "research-files",
  description: "Summarize important files in parallel.",
};

export default async ({ agent, pipeline }) => {
  const files = ["README.md", "SKILL.md"];
  return pipeline(files, file =>
    agent(`Read ${file} and summarize the important details.`, {
      label: file,
      mode: "read",
    })
  );
};
