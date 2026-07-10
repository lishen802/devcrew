import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactName, RunState } from "./types.js";

export function devcrewDir(cwd: string): string {
  return join(cwd, ".devcrew");
}

export function runsDir(cwd: string): string {
  return join(devcrewDir(cwd), "runs");
}

export function runDir(cwd: string, runId: string): string {
  return join(runsDir(cwd), runId);
}

export function executionWorktreePath(cwd: string, runId: string): string {
  return join(devcrewDir(cwd), "worktrees", runId);
}

export function statePath(cwd: string, runId: string): string {
  return join(runDir(cwd, runId), "state.json");
}

export function configPath(cwd: string): string {
  return join(devcrewDir(cwd), "config.json");
}

export function activeRunPath(cwd: string): string {
  return join(devcrewDir(cwd), "active-run.json");
}

export function standardsPath(cwd: string): string {
  return join(devcrewDir(cwd), "standards.md");
}

export function docsRoot(cwd: string): string {
  return join(cwd, "docs", "devcrew");
}

export function docsRunDir(cwd: string, runId: string): string {
  return join(docsRoot(cwd), runId);
}

export function artifactPath(cwd: string, runId: string, artifact: ArtifactName): string {
  const filenameByArtifact: Record<ArtifactName, string> = {
    requirements: "requirements.md",
    architecture: "architecture.md",
    "implementation-plan": "implementation-plan.md",
    "implementation-review": "implementation-review.md",
    "test-report": "test-report.md",
    acceptance: "acceptance.md",
  };
  return join(docsRunDir(cwd, runId), filenameByArtifact[artifact]);
}

export async function ensureRunDirectories(cwd: string, runId: string): Promise<void> {
  await mkdir(runDir(cwd, runId), { recursive: true });
  await mkdir(docsRunDir(cwd, runId), { recursive: true });
}

export async function ensureProjectDirectories(cwd: string): Promise<void> {
  await mkdir(devcrewDir(cwd), { recursive: true });
  await mkdir(docsRoot(cwd), { recursive: true });
}

export function relativeArtifactMap(state: RunState): Partial<Record<ArtifactName, string>> {
  return state.artifacts;
}
