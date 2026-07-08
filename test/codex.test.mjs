import test from "node:test";
import assert from "node:assert/strict";
import { buildCodexArgs, buildReviewCommand } from "../scripts/lib/codex.mjs";

test("builds read codex exec command", () => {
  const args = buildCodexArgs({
    mode: "read",
    result_path: "/tmp/result.md",
  }, "/repo");
  assert.deepEqual(args, [
    "exec",
    "--json",
    "--output-last-message",
    "/tmp/result.md",
    "--cd",
    "/repo",
    "--sandbox",
    "danger-full-access",
    "-",
  ]);
});

test("builds edit codex exec command", () => {
  const args = buildCodexArgs({
    mode: "edit",
    result_path: "/tmp/result.md",
    model: "gpt-test",
    schema: "/tmp/schema.json",
  }, "/repo");
  assert.equal(args.includes("danger-full-access"), true);
  assert.equal(args.includes("--model"), true);
  assert.equal(args.includes("--output-schema"), true);
});

test("builds codex review command", () => {
  assert.equal(buildReviewCommand(), "codex review --uncommitted");
  assert.equal(
    buildReviewCommand({ prompt: "review this", base: "main", commit: "abc123" }),
    "codex review --uncommitted --base 'main' --commit 'abc123' -",
  );
});
