import { readFile, writeFile } from "node:fs/promises";

import { ensureRunDirectories, statePath } from "./paths.js";
import type { RunState } from "./types.js";

export async function saveState(state: RunState): Promise<RunState> {
  state.updatedAt = new Date().toISOString();
  await ensureRunDirectories(state.cwd, state.runId);
  await writeFile(statePath(state.cwd, state.runId), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

export async function loadState(cwd: string, runId: string): Promise<RunState> {
  const raw = await readFile(statePath(cwd, runId), "utf8");
  return JSON.parse(raw) as RunState;
}
