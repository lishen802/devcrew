import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ensureRunDirectories, statePath } from "./paths.js";
import type { RunState } from "./types.js";

export async function saveState(state: RunState): Promise<RunState> {
  state.updatedAt = new Date().toISOString();
  await ensureRunDirectories(state.cwd, state.runId);
  const target = statePath(state.cwd, state.runId);
  const temp = join(dirname(target), `.state.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temp, target);
  return state;
}

export async function loadState(cwd: string, runId: string): Promise<RunState> {
  const raw = await readFile(statePath(cwd, runId), "utf8");
  const parsed = JSON.parse(raw) as RunState;
  return {
    ...parsed,
    executionMode: parsed.executionMode ?? "plan",
    changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles : [],
    implementationDiff: typeof parsed.implementationDiff === "string" ? parsed.implementationDiff : "",
    verification: Array.isArray(parsed.verification) ? parsed.verification : [],
    lintResults: Array.isArray(parsed.lintResults) ? parsed.lintResults : [],
  };
}
