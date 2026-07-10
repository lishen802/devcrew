import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  executionWorktreePath,
  runDir,
  type ExecutionWorkspace,
  type RunState,
} from "../../core/src/index.js";

export interface CapturedExecutionChanges {
  changedFiles: string[];
  patch: string;
}

const REPOSITORY_PATHS = [
  ".",
  ":(exclude).devcrew",
  ":(exclude).devcrew/**",
  ":(exclude)docs/devcrew",
  ":(exclude)docs/devcrew/**",
];

async function runGit(args: string[], cwd: string, stdin?: string): Promise<string> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      rejectResult(error);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectOnce);
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (code === 0) {
        resolveResult(stdout);
        return;
      }
      rejectResult(new Error(`git ${args[0]} failed: ${(stderr || stdout).trim()}`));
    });
    child.stdin.end(stdin);
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertCleanRequester(cwd: string): Promise<void> {
  const status = await runGit(
    [
      "status",
      "--porcelain",
      "-uall",
      "--",
      ...REPOSITORY_PATHS,
    ],
    cwd,
  );
  if (status.trim()) {
    throw new Error("DevCrew apply promotion requires a clean working tree");
  }
}

function nulPaths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function parseChangedFiles(output: string): string[] {
  const fields = nulPaths(output);
  const paths: string[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    const firstPath = fields[index++];
    if (!status || !firstPath) {
      throw new Error("DevCrew could not parse git diff name status output");
    }
    paths.push(firstPath);
    if (status.startsWith("R") || status.startsWith("C")) {
      const secondPath = fields[index++];
      if (!secondPath) {
        throw new Error("DevCrew could not parse renamed git diff path");
      }
      paths.push(secondPath);
    }
  }
  return [...new Set(paths)];
}

async function markUntrackedIntentToAdd(cwd: string): Promise<void> {
  const untracked = nulPaths(
    await runGit(["ls-files", "--others", "--exclude-standard", "-z", "--", ...REPOSITORY_PATHS], cwd),
  );
  if (untracked.length > 0) {
    await runGit(["add", "-N", "--", ...untracked], cwd);
  }
}

async function capturePatch(workspace: ExecutionWorkspace): Promise<CapturedExecutionChanges> {
  await markUntrackedIntentToAdd(workspace.path);
  const changedFiles = parseChangedFiles(
    await runGit(
      ["diff", "--name-status", "-z", workspace.baseCommit, "--", ...REPOSITORY_PATHS],
      workspace.path,
    ),
  );
  const patch = await runGit(
    ["diff", "--binary", "--no-ext-diff", workspace.baseCommit, "--", ...REPOSITORY_PATHS],
    workspace.path,
  );
  if (!patch.trim()) {
    throw new Error("DevCrew apply implementer produced no repository changes");
  }
  return { changedFiles, patch };
}

export async function ensureExecutionWorkspace(state: RunState): Promise<ExecutionWorkspace> {
  if (state.executionWorkspace && (await pathExists(state.executionWorkspace.path))) {
    return state.executionWorkspace;
  }

  await assertCleanRequester(state.cwd);
  const baseCommit = (await runGit(["rev-parse", "HEAD"], state.cwd)).trim();
  const path = executionWorktreePath(state.cwd, state.runId);
  await mkdir(dirname(path), { recursive: true });
  await runGit(["worktree", "add", "--detach", path, baseCommit], state.cwd);
  return { path, baseCommit };
}

export async function captureExecutionChanges(
  workspace: ExecutionWorkspace,
): Promise<CapturedExecutionChanges> {
  const head = (await runGit(["rev-parse", "HEAD"], workspace.path)).trim();
  if (head !== workspace.baseCommit) {
    await runGit(["reset", "--mixed", workspace.baseCommit], workspace.path);
  }
  return capturePatch(workspace);
}

export async function promoteExecutionChanges(state: RunState): Promise<void> {
  const workspace = state.executionWorkspace;
  if (!workspace || !state.implementationDiff.trim()) {
    throw new Error("DevCrew apply promotion requires reviewed execution changes");
  }

  await assertCleanRequester(state.cwd);
  const requesterHead = (await runGit(["rev-parse", "HEAD"], state.cwd)).trim();
  if (requesterHead !== workspace.baseCommit) {
    throw new Error("DevCrew apply promotion refused because requester HEAD changed");
  }

  const patchPath = join(runDir(state.cwd, state.runId), "implementation.patch");
  await mkdir(dirname(patchPath), { recursive: true });
  await writeFile(patchPath, state.implementationDiff);
  await runGit(["apply", "--check", "--binary", patchPath], state.cwd);
  await runGit(["apply", "--binary", patchPath], state.cwd);

  const promoted = await capturePatch({ path: state.cwd, baseCommit: workspace.baseCommit });
  await runGit(["reset", "--mixed", workspace.baseCommit], state.cwd);
  if (promoted.patch !== state.implementationDiff) {
    try {
      await runGit(["apply", "--reverse", "--binary", patchPath], state.cwd);
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new Error(`DevCrew promoted patch verification failed and rollback failed${detail}`);
    }
    throw new Error("DevCrew promoted patch differs from the reviewed implementation diff");
  }

  await runGit(["worktree", "remove", "--force", workspace.path], state.cwd);
  await runGit(["worktree", "prune"], state.cwd);
}

export async function executionCwd(state: RunState): Promise<string> {
  if (state.executionMode !== "apply") {
    return state.cwd;
  }
  return (await ensureExecutionWorkspace(state)).path;
}
