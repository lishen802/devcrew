import { readFile, unlink, writeFile } from "node:fs/promises";

import { activeRunPath, ensureProjectDirectories } from "./paths.js";

export interface ActiveRun {
  runId: string;
  updatedAt: string;
}

export async function setActiveRun(cwd: string, runId: string): Promise<ActiveRun> {
  await ensureProjectDirectories(cwd);
  const active: ActiveRun = {
    runId,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(activeRunPath(cwd), `${JSON.stringify(active, null, 2)}\n`, "utf8");
  return active;
}

export async function getActiveRunId(cwd: string): Promise<string> {
  try {
    const raw = await readFile(activeRunPath(cwd), "utf8");
    const parsed = JSON.parse(raw) as Partial<ActiveRun>;
    if (typeof parsed.runId === "string" && parsed.runId.trim()) {
      return parsed.runId.trim();
    }
  } catch {
    // Fall through to the explicit error below.
  }
  throw new Error("No active DevCrew run. Pass runId or start a workflow first.");
}

export async function clearActiveRunIfMatches(cwd: string, runId: string): Promise<boolean> {
  try {
    if ((await getActiveRunId(cwd)) !== runId) {
      return false;
    }
    await unlink(activeRunPath(cwd));
    return true;
  } catch {
    return false;
  }
}
