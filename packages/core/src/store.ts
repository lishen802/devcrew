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
  const executionWorkspace = parsed.executionWorkspace;
  const executionInstruction = parsed.executionInstruction;
  const verificationWaiver = parsed.verificationWaiver;
  return {
    ...parsed,
    executionMode: parsed.executionMode ?? "plan",
    executionPolicy: parsed.executionPolicy ?? "interactive-host",
    executionWorkspace:
      executionWorkspace &&
      typeof executionWorkspace.path === "string" &&
      typeof executionWorkspace.baseCommit === "string"
        ? executionWorkspace
        : undefined,
    executionInstruction:
      executionInstruction &&
      (executionInstruction.phase === "execution" || executionInstruction.phase === "testing") &&
      typeof executionInstruction.workspacePath === "string" &&
      typeof executionInstruction.instructions === "string" &&
      typeof executionInstruction.createdAt === "string"
        ? executionInstruction
        : undefined,
    changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles : [],
    pendingQuestions: Array.isArray(parsed.pendingQuestions)
      ? parsed.pendingQuestions.filter((question): question is string => typeof question === "string" && question.trim().length > 0)
      : [],
    implementationDiff: typeof parsed.implementationDiff === "string" ? parsed.implementationDiff : "",
    verification: Array.isArray(parsed.verification) ? parsed.verification : [],
    verificationStatus:
      parsed.verificationStatus === "passed" || parsed.verificationStatus === "failed" ? parsed.verificationStatus : "not_run",
    verificationWaiver:
      verificationWaiver &&
      typeof verificationWaiver.reason === "string" &&
      typeof verificationWaiver.createdAt === "string"
        ? verificationWaiver
        : undefined,
    lintResults: Array.isArray(parsed.lintResults) ? parsed.lintResults : [],
  };
}
