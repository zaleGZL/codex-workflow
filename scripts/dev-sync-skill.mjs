#!/usr/bin/env node
import { cp, mkdir, rm } from "node:fs/promises";
import { watch } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const skillName = "codex-workflow";
const targetRoot = path.join(os.homedir(), ".codex", "skills");
const target = path.join(targetRoot, skillName);
const once = process.argv.includes("--once");
const include = new Set(["SKILL.md", "agents", "references", "scripts", "examples", "package.json"]);

let syncing = false;
let pending = false;
let timer = null;

await sync();

if (!once) {
  console.log(`Watching ${root}`);
  console.log(`Sync target ${target}`);
  watch(root, { recursive: true }, (_event, filename) => {
    if (!filename || shouldIgnore(filename)) return;
    clearTimeout(timer);
    timer = setTimeout(queueSync, 100);
  });
}

async function queueSync() {
  if (syncing) {
    pending = true;
    return;
  }
  await sync();
  if (pending) {
    pending = false;
    await queueSync();
  }
}

async function sync() {
  syncing = true;
  try {
    await mkdir(targetRoot, { recursive: true });
    await mkdir(target, { recursive: true });
    for (const name of include) {
      await rm(path.join(target, name), { recursive: true, force: true });
      await cp(path.join(root, name), path.join(target, name), {
        recursive: true,
        filter(source) {
          const rel = path.relative(root, source);
          return !shouldIgnore(rel);
        },
      });
    }
    console.log(`Synced ${skillName} -> ${target}`);
  } finally {
    syncing = false;
  }
}

function shouldIgnore(rel) {
  const parts = rel.split(path.sep);
  return parts.some(part =>
    part === ".git" ||
    part === ".codex" ||
    part === "node_modules" ||
    part === "test" ||
    part === ".DS_Store"
  );
}
