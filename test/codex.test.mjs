import test from "node:test";
import assert from "node:assert/strict";
import { buildCodexArgs } from "../scripts/lib/codex.mjs";

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
    "read-only",
    "--ask-for-approval",
    "never",
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
  assert.equal(args.includes("workspace-write"), true);
  assert.equal(args.includes("--model"), true);
  assert.equal(args.includes("--output-schema"), true);
});
