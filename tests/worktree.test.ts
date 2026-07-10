import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

import { startWorkflow, type RunState } from "../packages/core/src/index.js";
import {
  captureExecutionChanges,
  ensureExecutionWorkspace,
  promoteExecutionChanges,
} from "../packages/orchestrator/src/worktree.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function applyStateFixture(): Promise<RunState> {
  const cwd = await mkdtemp(join(tmpdir(), "devcrew-worktree-"));
  await execFileAsync("git", ["init"], { cwd });
  await git(cwd, ["config", "user.email", "devcrew@example.test"]);
  await git(cwd, ["config", "user.name", "DevCrew Test"]);
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
  await writeFile(join(cwd, "README.md"), "# Fixture\n");
  await writeFile(join(cwd, "rename-me.txt"), "rename me\n");
  await writeFile(join(cwd, "delete-me.txt"), "delete me\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-m", "base"]);

  return startWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Apply fixture changes",
    backend: "codex",
    executionMode: "apply",
  });
}

test("captureExecutionChanges includes commits, staged, unstaged, renamed, deleted, binary, and untracked files", async () => {
  const state = await applyStateFixture();
  const workspace = await ensureExecutionWorkspace(state);

  await writeFile(join(workspace.path, "committed.txt"), "committed\n");
  await git(workspace.path, ["add", "committed.txt"]);
  await git(workspace.path, ["commit", "-m", "agent commit"]);
  await writeFile(join(workspace.path, "unstaged.txt"), "unstaged\n");
  await writeFile(join(workspace.path, "staged.txt"), "staged\n");
  await git(workspace.path, ["add", "staged.txt"]);
  await git(workspace.path, ["mv", "rename-me.txt", "renamed.txt"]);
  await rm(join(workspace.path, "delete-me.txt"));
  await writeFile(join(workspace.path, "binary.bin"), Buffer.from([0, 1, 2, 255]));

  const captured = await captureExecutionChanges(workspace);
  assert.match(captured.patch, /committed\.txt/);
  assert.match(captured.patch, /staged\.txt/);
  assert.match(captured.patch, /unstaged\.txt/);
  assert.match(captured.patch, /renamed\.txt/);
  assert.match(captured.patch, /delete-me\.txt/);
  assert.match(captured.patch, /GIT binary patch|binary\.bin/);
  assert.equal((await git(workspace.path, ["rev-parse", "HEAD"])).trim(), workspace.baseCommit);
});

test("promoteExecutionChanges applies exactly the reviewed patch", async () => {
  const state = await applyStateFixture();
  const workspace = await ensureExecutionWorkspace(state);
  await writeFile(join(workspace.path, "feature.ts"), "export const feature = true;\n");
  const captured = await captureExecutionChanges(workspace);
  state.executionWorkspace = workspace;
  state.implementationDiff = captured.patch;

  await promoteExecutionChanges(state);

  assert.equal(await readFile(join(state.cwd, "feature.ts"), "utf8"), "export const feature = true;\n");
  assert.equal(await pathExists(workspace.path), false);
});

test("promotion refuses a changed requester HEAD or dirty requester worktree", async () => {
  const state = await applyStateFixture();
  const workspace = await ensureExecutionWorkspace(state);
  await writeFile(join(workspace.path, "feature.ts"), "export const feature = true;\n");
  state.executionWorkspace = workspace;
  state.implementationDiff = (await captureExecutionChanges(workspace)).patch;

  await writeFile(join(state.cwd, "README.md"), "dirty\n");
  await assert.rejects(() => promoteExecutionChanges(state), /clean working tree/);
  assert.equal(await pathExists(workspace.path), true);
});

test("promotion refuses a requester HEAD that changed after execution started", async () => {
  const state = await applyStateFixture();
  const workspace = await ensureExecutionWorkspace(state);
  await writeFile(join(workspace.path, "feature.ts"), "export const feature = true;\n");
  state.executionWorkspace = workspace;
  state.implementationDiff = (await captureExecutionChanges(workspace)).patch;

  await writeFile(join(state.cwd, "requester.txt"), "requester commit\n");
  await git(state.cwd, ["add", "requester.txt"]);
  await git(state.cwd, ["commit", "-m", "requester advanced"]);

  await assert.rejects(() => promoteExecutionChanges(state), /requester HEAD changed/);
  assert.equal(await pathExists(workspace.path), true);
});

test("captureExecutionChanges rejects an empty apply result", async () => {
  const state = await applyStateFixture();
  const workspace = await ensureExecutionWorkspace(state);
  await assert.rejects(() => captureExecutionChanges(workspace), /produced no repository changes/);
});
