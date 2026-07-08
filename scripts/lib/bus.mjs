import path from "node:path";
import { readJson, runDir, writeJsonAtomic } from "./state.mjs";

export function busPath(cwd, runId) {
  return path.join(runDir(cwd, runId), "bus.json");
}

export function emptyBus() {
  return { tasks: [], messages: [], context: [] };
}

export async function initBus(cwd, runId) {
  await writeBus(cwd, runId, emptyBus());
}

export async function ensureBus(cwd, runId) {
  const bus = await readBus(cwd, runId);
  await writeBus(cwd, runId, bus);
}

export async function readBus(cwd, runId) {
  try {
    return normalizeBus(await readJson(busPath(cwd, runId)));
  } catch (error) {
    if (error.code === "ENOENT") return emptyBus();
    throw error;
  }
}

export async function writeBus(cwd, runId, bus) {
  await writeJsonAtomic(busPath(cwd, runId), normalizeBus(bus));
}

export async function updateBus(cwd, runId, mutator) {
  const bus = await readBus(cwd, runId);
  const result = await mutator(bus);
  await writeBus(cwd, runId, bus);
  return result;
}

export function nextBusId(prefix, items) {
  return `${prefix}-${String(items.length + 1).padStart(3, "0")}`;
}

function normalizeBus(bus) {
  return {
    tasks: Array.isArray(bus?.tasks) ? bus.tasks : [],
    messages: Array.isArray(bus?.messages) ? bus.messages : [],
    context: Array.isArray(bus?.context) ? bus.context : [],
  };
}
