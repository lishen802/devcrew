# DevCrew P0 Foundation Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DevCrew apply mode approval-first and worktree-isolated while repairing gate idempotency, stdio recovery, local-backend false success, and plugin version drift.

**Architecture:** Keep the four public gates stable. Add an internal nongated `execution` phase after implementation-plan approval, execute implementation and verification in `.devcrew/worktrees/<run-id>`, and promote the reviewed binary patch only when the testing gate is approved. Core owns legal state transitions, the orchestrator owns execution workspaces and promotion, and stdio remains a serialized but failure-recovering transport.

**Tech Stack:** TypeScript 5.8, Node.js 20+, Node test runner, Git worktrees, JSON-RPC/MCP, npm/Codex plugins.

---

## File Map

- `packages/core/src/types.ts`: add the internal execution phase and persisted workspace metadata.
- `packages/core/src/workflow.ts`: enforce gate invariants, reject local apply, and branch plan/apply after implementation-plan approval.
- `packages/core/src/store.ts`: load older state while validating optional workspace metadata.
- `packages/adapters/src/index.ts`: keep implementation planning read-only and allow writes only in the execution/testing phases.
- `packages/orchestrator/src/worktree.ts`: own worktree creation, complete patch capture, promotion, and cleanup.
- `packages/orchestrator/src/index.ts`: route planning, execution, testing, rejection revision, and testing approval.
- `packages/service/src/tools.ts`: use orchestrated approval for patch promotion.
- `packages/service/src/stdio.ts`: validate JSON-RPC request shape and recover the serialized queue.
- `packages/plugins/src/index.ts`: continue generating every plugin version reference from shared constants.
- `plugins/devcrew-codex/**`: synchronize the checked-in generated bundle.
- `tests/core.test.ts`, `tests/stdio.test.ts`, `tests/orchestrator.test.ts`, `tests/service.test.ts`, `tests/plugins.test.ts`: regression coverage.
- `package.json`, `package-lock.json`, `packages/core/src/version.ts`, `scripts/smoke-codex-plugin.mjs`: version `0.1.2` synchronization.
- `README.md`, `README.zh-CN.md`, `docs/workflow.md`, `docs/codex.md`: describe the corrected apply flow and release order.

### Task 1: Enforce Core State And Backend Invariants

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/workflow.ts`
- Modify: `packages/core/src/store.ts`
- Test: `tests/core.test.ts`

- [ ] **Step 1: Write failing core regression tests**

Add tests that express the desired API before changing production code:

```ts
test("apply mode rejects the deterministic local backend", async () => {
  const cwd = await tempProject();
  await assert.rejects(
    () => startWorkflow({
      cwd,
      host: "codex",
      mode: "feature",
      request: "Make a real change",
      backend: "local",
      executionMode: "apply",
    }),
    /apply mode requires a codex or claude backend/i,
  );
});

test("apply implementation approval advances to execution while plan advances to testing", async () => {
  const apply = await startWorkflow({
    cwd: await tempProject(),
    host: "codex",
    mode: "feature",
    request: "Apply a change",
    backend: "codex",
    executionMode: "apply",
  });
  apply.phase = "implementation";
  apply.status = "awaiting_approval";
  apply.gates.requirements = "approved";
  apply.gates.architecture = "approved";
  apply.gates.implementation = "pending";
  await saveState(apply);
  assert.equal((await approveWorkflow({ cwd: apply.cwd, runId: apply.runId, gate: "implementation" })).phase, "execution");

  const plan = await startWorkflow({
    cwd: await tempProject(),
    host: "codex",
    mode: "feature",
    request: "Plan a change",
    backend: "local",
  });
  plan.phase = "implementation";
  plan.status = "awaiting_approval";
  plan.gates.requirements = "approved";
  plan.gates.architecture = "approved";
  plan.gates.implementation = "pending";
  await saveState(plan);
  assert.equal((await approveWorkflow({ cwd: plan.cwd, runId: plan.runId, gate: "implementation" })).phase, "testing");
});

test("completed workflows cannot be reopened and duplicate approval is idempotent", async () => {
  const cwd = await tempProject();
  const state = await startWorkflow({ cwd, host: "codex", mode: "feature", request: "Plan", backend: "local" });
  state.phase = "complete";
  state.status = "complete";
  state.gates.requirements = "approved";
  state.approvals.push({ gate: "requirements", createdAt: new Date().toISOString() });
  await saveState(state);

  const repeated = await approveWorkflow({ cwd, runId: state.runId, gate: "requirements" });
  assert.equal(repeated.phase, "complete");
  assert.equal(repeated.status, "complete");
  assert.equal(repeated.approvals.length, 1);
});

test("reject and answer enforce the current gate state", async () => {
  const cwd = await tempProject();
  const state = await startWorkflow({ cwd, host: "codex", mode: "feature", request: "Plan", backend: "local" });
  await assert.rejects(
    () => answerWorkflow({ cwd, runId: state.runId, answer: "Unsolicited answer" }),
    /awaiting_input/,
  );
  await assert.rejects(
    () => rejectWorkflow({ cwd, runId: state.runId, gate: "architecture", feedback: "Wrong gate" }),
    /current gate is requirements/,
  );
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --import tsx --test --test-name-pattern="local backend|advances to execution|cannot be reopened|enforce the current gate" tests/core.test.ts
```

Expected: failures showing local apply is accepted, `execution` is not a valid phase, completed approval reopens the run, and answer is accepted outside `awaiting_input`.

- [ ] **Step 3: Add execution metadata and state migration**

Add the phase and state type in `packages/core/src/types.ts`:

```ts
export const PHASES = [
  "requirements",
  "architecture",
  "implementation",
  "execution",
  "testing",
  "acceptance",
  "complete",
] as const;

export interface ExecutionWorkspace {
  path: string;
  baseCommit: string;
}

export interface RunState {
  // existing fields stay unchanged
  executionWorkspace?: ExecutionWorkspace;
}
```

Normalize the optional field in `loadState`:

```ts
const executionWorkspace = parsed.executionWorkspace;
return {
  ...parsed,
  executionMode: parsed.executionMode ?? "plan",
  executionWorkspace:
    executionWorkspace &&
    typeof executionWorkspace.path === "string" &&
    typeof executionWorkspace.baseCommit === "string"
      ? executionWorkspace
      : undefined,
  changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles : [],
  implementationDiff: typeof parsed.implementationDiff === "string" ? parsed.implementationDiff : "",
  verification: Array.isArray(parsed.verification) ? parsed.verification : [],
  lintResults: Array.isArray(parsed.lintResults) ? parsed.lintResults : [],
};
```

- [ ] **Step 4: Implement legal and idempotent transitions**

Change phase routing to use the run mode:

```ts
export function nextPhaseAfterGate(state: RunState, gate: GateName): RunState["phase"] {
  switch (gate) {
    case "requirements":
      return "architecture";
    case "architecture":
      return "implementation";
    case "implementation":
      return state.executionMode === "apply" ? "execution" : "testing";
    case "testing":
      return "acceptance";
  }
}
```

Map `execution` to the review artifact and no public gate:

```ts
execution: "implementation-review",
```

Replace the permissive assertion with:

```ts
function assertPendingCurrentGate(state: RunState, gate: GateName): void {
  const expected = gateForPhase(state.phase);
  if (expected !== gate) {
    throw new Error(expected
      ? `Cannot act on ${gate} while current gate is ${expected}`
      : `Cannot act on ${gate} while workflow phase is ${state.phase}`);
  }
  if (state.status !== "awaiting_approval" || state.gates[gate] !== "pending") {
    throw new Error(`Gate ${gate} is not pending approval`);
  }
}
```

In `approveWorkflow`, return immediately when `state.gates[gate] === "approved"`; otherwise call the strict assertion, record one approval, and use `nextPhaseAfterGate(state, gate)`. Apply the equivalent early return for an already rejected gate in `rejectWorkflow`.

Guard answers before mutation:

```ts
const gate = gateForPhase(state.phase);
if (state.status !== "awaiting_input" || !gate || state.gates[gate] !== "rejected") {
  throw new Error("Workflow must be awaiting_input at a rejected current gate before recording an answer");
}
```

After resolving `backend` and `executionMode` in `startWorkflow`, reject false apply:

```ts
if (executionMode === "apply" && backend === "local") {
  throw new Error("DevCrew apply mode requires a codex or claude backend; local is plan-only");
}
```

- [ ] **Step 5: Run core tests and verify GREEN**

Run:

```bash
node --import tsx --test tests/core.test.ts
```

Expected: all core tests pass, including existing 0.1.1 state migration coverage.

- [ ] **Step 6: Commit the core contract**

```bash
git add packages/core/src/types.ts packages/core/src/workflow.ts packages/core/src/store.ts tests/core.test.ts
git commit -m "fix: enforce workflow state invariants"
```

### Task 2: Make Stdio Validation And Queue Recovery Complete

**Files:**
- Modify: `packages/service/src/stdio.ts`
- Test: `tests/stdio.test.ts`

- [ ] **Step 1: Write failing JSON-RPC and queue recovery tests**

```ts
test("stdio rejects valid JSON with an invalid request shape", async () => {
  for (const line of [
    "null",
    "[]",
    JSON.stringify({ jsonrpc: "1.0", id: 1, method: "tools/list" }),
    JSON.stringify({ jsonrpc: "2.0", id: 1 }),
  ]) {
    const output: unknown[] = [];
    const processLine = createStdioLineProcessor((message) => output.push(message));
    await processLine(line);
    assert.deepEqual((output[0] as { error: unknown }).error, {
      code: -32600,
      message: "Invalid Request",
    });
  }
});

test("stdio continues after a queued handler rejects", async () => {
  const calls: string[] = [];
  const processLine = createStdioLineProcessor(() => {}, async (request) => {
    calls.push(String(request.id));
    if (request.id === 1) throw new Error("first failed");
  });

  await assert.rejects(
    () => processLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })),
    /first failed/,
  );
  await processLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  assert.deepEqual(calls, ["1", "2"]);
});
```

- [ ] **Step 2: Run focused stdio tests and verify RED**

```bash
node --import tsx --test --test-name-pattern="invalid request shape|continues after" tests/stdio.test.ts
```

Expected: `null` throws before a response and the second queued request inherits the first rejection.

- [ ] **Step 3: Validate request objects and recover the internal queue**

Extend the request shape and add a type guard:

```ts
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
    typeof (value as { method?: unknown }).method === "string";
}
```

Parse to `unknown`; after parsing, return this response when the guard fails:

```ts
write({
  jsonrpc: "2.0",
  id: null,
  error: { code: -32600, message: "Invalid Request" },
});
return queue;
```

Replace queue assignment with a caller-visible task plus an internally recovered queue:

```ts
const task = queue.then(() => handler(request));
queue = task.catch(() => undefined);
return task;
```

- [ ] **Step 4: Run stdio tests and verify GREEN**

```bash
node --import tsx --test tests/stdio.test.ts
```

Expected: parse errors, invalid requests, notifications, ordering, recovery, and version tests pass.

- [ ] **Step 5: Commit stdio reliability**

```bash
git add packages/service/src/stdio.ts tests/stdio.test.ts
git commit -m "fix: recover stdio after invalid requests"
```

### Task 3: Build The Isolated Git Worktree Execution Layer

**Files:**
- Create: `packages/orchestrator/src/worktree.ts`
- Modify: `packages/core/src/paths.ts`
- Test: `tests/worktree.test.ts`

- [ ] **Step 1: Write real-Git failing tests for capture and promotion**

Create `tests/worktree.test.ts` with a real temporary repository helper and these behaviors:

```ts
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
  await writeFile(join(cwd, ".gitignore"), ".devcrew/\ndocs/devcrew/\n");
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

test("captureExecutionChanges rejects an empty apply result", async () => {
  const state = await applyStateFixture();
  const workspace = await ensureExecutionWorkspace(state);
  await assert.rejects(() => captureExecutionChanges(workspace), /produced no repository changes/);
});
```

- [ ] **Step 2: Run worktree tests and verify RED**

```bash
node --import tsx --test tests/worktree.test.ts
```

Expected: module-not-found failure for `packages/orchestrator/src/worktree.ts`.

- [ ] **Step 3: Add the run-owned worktree path**

In `packages/core/src/paths.ts`:

```ts
export function executionWorktreePath(cwd: string, runId: string): string {
  return join(devcrewDir(cwd), "worktrees", runId);
}
```

- [ ] **Step 4: Implement the worktree module**

Create these exported contracts in `packages/orchestrator/src/worktree.ts`:

```ts
export interface CapturedExecutionChanges {
  changedFiles: string[];
  patch: string;
}

export async function ensureExecutionWorkspace(state: RunState): Promise<ExecutionWorkspace>;
export async function captureExecutionChanges(workspace: ExecutionWorkspace): Promise<CapturedExecutionChanges>;
export async function promoteExecutionChanges(state: RunState): Promise<void>;
export async function executionCwd(state: RunState): Promise<string>;
```

Use one non-shell Git runner so paths are never interpolated:

```ts
async function runGit(args: string[], cwd: string, stdin?: string): Promise<string> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", rejectResult);
    child.on("close", (code) => {
      if (code === 0) resolveResult(stdout);
      else rejectResult(new Error(`git ${args[0]} failed: ${(stderr || stdout).trim()}`));
    });
    child.stdin.end(stdin);
  });
}
```

`ensureExecutionWorkspace` must return existing persisted metadata when its path is accessible. Otherwise it asserts requester cleanliness, resolves `HEAD`, creates the parent directory, runs:

```ts
await runGit(["worktree", "add", "--detach", path, baseCommit], state.cwd);
```

`captureExecutionChanges` must:

1. Compare worktree `HEAD` with `baseCommit` and run `git reset --mixed <baseCommit>` when the role committed.
2. Read untracked paths with `git ls-files --others --exclude-standard -z` and run `git add -N -- <paths>` inside the isolated worktree.
3. Read changed names with `git diff --name-status -z <baseCommit> --` and parse status/path tuples, including two paths for `R*` and `C*` statuses.
4. Capture `git diff --binary --no-ext-diff <baseCommit> --`.
5. Throw `DevCrew apply implementer produced no repository changes` when the patch is empty.

`promoteExecutionChanges` must:

1. Assert requester cleanliness and unchanged `HEAD`.
2. Write `implementation.patch` under `runDir(state.cwd, state.runId)`.
3. Run `git apply --check --binary <patch-path>` then `git apply --binary <patch-path>` in the requester repository.
4. Mark promoted untracked files intent-to-add, capture the requester patch against `baseCommit`, then run `git reset --mixed <baseCommit>` to leave all promoted changes unstaged.
5. If the captured patch differs from `state.implementationDiff`, reverse the patch and throw.
6. Run `git worktree remove --force <workspace.path>` and `git worktree prune` only after successful verification.

- [ ] **Step 5: Run worktree tests and verify GREEN**

```bash
node --import tsx --test tests/worktree.test.ts
```

Expected: all real-Git capture, promotion, precondition, and empty-output tests pass.

- [ ] **Step 6: Commit worktree isolation**

```bash
git add packages/core/src/paths.ts packages/orchestrator/src/worktree.ts tests/worktree.test.ts
git commit -m "feat: isolate apply changes in git worktrees"
```

### Task 4: Route Planning, Execution, Testing, And Promotion

**Files:**
- Modify: `packages/adapters/src/index.ts`
- Modify: `packages/orchestrator/src/index.ts`
- Modify: `packages/service/src/tools.ts`
- Test: `tests/adapters-sdk.test.ts`
- Test: `tests/orchestrator.test.ts`
- Test: `tests/service.test.ts`

- [ ] **Step 1: Write failing orchestration sequence tests**

Add tests proving the first writable implementer call occurs only after implementation approval and uses the isolated path:

```ts
function validRoleResult(input: RoleRunInput): RoleResult {
  return {
    role: input.role,
    backend: input.backend,
    summary: `${input.role} completed`,
    markdown: `# ${input.role}\n\nCompleted ${input.phase}.\n`,
    usedFallback: false,
  };
}

test("apply mode plans read-only before executing in a worktree", async () => {
  const cwd = await tempProject();
  await initGitRepo(cwd);
  const calls: RoleRunInput[] = [];
  const runner = async (input: RoleRunInput): Promise<RoleResult> => {
    calls.push(input);
    if (input.phase === "execution") {
      await writeFile(join(input.cwd, "generated.ts"), "export const generated = true;\n");
    }
    return validRoleResult(input);
  };

  const started = await startOrchestratedWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Add generated code",
    backend: "codex",
    executionMode: "apply",
  }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "requirements" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "architecture" });
  const planned = await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);

  assert.equal(calls.at(-1)?.phase, "implementation");
  assert.equal(calls.at(-1)?.executionMode, "plan");
  assert.equal(calls.at(-1)?.cwd, cwd);
  assert.equal(await pathExists(join(cwd, "generated.ts")), false);

  await approveWorkflow({ cwd, runId: started.runId, gate: "implementation" });
  const executed = await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  assert.equal(calls.at(-1)?.phase, "execution");
  assert.equal(calls.at(-1)?.executionMode, "apply");
  assert.notEqual(calls.at(-1)?.cwd, cwd);
  assert.equal(executed.phase, "testing");
  assert.equal(executed.status, "ready");
  assert.match(executed.implementationDiff, /generated\.ts/);
  assert.equal(await pathExists(join(cwd, "generated.ts")), false);
});
```

Add service/orchestrator tests that testing approval promotes the patch once, duplicate approval is a no-op, and rejected testing plus answer returns to `execution/ready` without touching the requester repository.

- [ ] **Step 2: Run orchestration tests and verify RED**

```bash
node --import tsx --test --test-name-pattern="plans read-only|promotes the patch|returns to execution" tests/orchestrator.test.ts tests/service.test.ts
```

Expected: implementation writes before its gate, there is no execution routing, and approval does not promote a worktree patch.

- [ ] **Step 3: Make adapter permissions phase-aware**

Update phase titles:

```ts
execution: "Implementation Review",
```

Restrict apply capability to real execution and testing:

```ts
function roleCanApply(input: RoleRunInput): boolean {
  return input.executionMode === "apply" &&
    (input.phase === "execution" || input.phase === "testing");
}
```

The orchestrator passes `executionMode: "plan"` for the implementation-plan phase even when `state.executionMode` is apply.

- [ ] **Step 4: Refactor current-phase orchestration**

Add `execution: "implementer"` to `roleForPhase`. Handle the nongated execution phase before the existing gate branch:

```ts
if (state.phase === "execution") {
  const workspace = await ensureExecutionWorkspace(state);
  state.executionWorkspace = workspace;
  await saveState(state);

  const result = await runner({
    backend: state.backend,
    role: "implementer",
    phase: "execution",
    request: state.request,
    mode: state.mode,
    executionMode: "apply",
    cwd: workspace.path,
    standards: state.standards.combined,
    artifactPath: artifactPath(state.cwd, state.runId, "implementation-review"),
    answers: state.answers.map((entry) => entry.answer),
    feedback: state.feedback.map((entry) => `${entry.gate}: ${entry.message}`),
    priorArtifacts: await readPriorArtifacts(state),
  });
  const captured = await captureExecutionChanges(workspace);
  state.changedFiles = captured.changedFiles;
  state.implementationDiff = captured.patch;
  state.lintResults = await runConfiguredLint(state, workspace.path);
  state.roles.push(result);
  state.artifacts["implementation-review"] = await writeMarkdownArtifact(
    state,
    "implementation-review",
    renderArtifact("implementation-review", state),
  );
  state.phase = "testing";
  state.status = "ready";
  return saveState(state);
}
```

For the normal implementation phase, pass `executionMode: "plan"` and the requester `cwd`. For apply-mode testing, use `executionWorkspace.path` for the tester and for `runConfiguredVerification`. After tester/verification completion, call `captureExecutionChanges` again and rewrite `implementation-review.md` so testing cannot silently alter the reviewed patch.

Change `runConfiguredLint` and `runConfiguredVerification` to accept an explicit command cwd while still reading config from `state.cwd`.

- [ ] **Step 5: Add orchestrated approval and revision routing**

Export:

```ts
export async function approveOrchestratedWorkflow(input: ApproveWorkflowInput): Promise<RunState> {
  const before = await getWorkflowStatus(input);
  if (
    input.gate === "testing" &&
    before.executionMode === "apply" &&
    before.gates.testing !== "approved"
  ) {
    await promoteExecutionChanges(before);
  }
  const state = await approveWorkflow(input);
  if (input.gate === "testing" && state.executionWorkspace) {
    state.executionWorkspace = undefined;
    return saveState(state);
  }
  return state;
}
```

In `answerOrchestratedWorkflow`, inspect the state before answering. When it is an apply-mode rejected testing gate, record the answer, then set:

```ts
state.phase = "execution";
state.status = "ready";
state.gates.testing = "not_started";
return saveState(state);
```

Update `packages/service/src/tools.ts` to call `approveOrchestratedWorkflow` instead of the core `approveWorkflow`.

- [ ] **Step 6: Remove obsolete in-place rollback behavior**

Delete the in-place `revertChangedFiles`, baseline-diff, and testing-rejection rollback branches from `packages/orchestrator/src/index.ts`. Replace their unit tests with the worktree isolation and revision tests. Do not leave two apply ownership models active.

- [ ] **Step 7: Run adapter, orchestrator, and service tests and verify GREEN**

```bash
node --import tsx --test tests/adapters.test.ts tests/adapters-sdk.test.ts tests/orchestrator.test.ts tests/service.test.ts tests/worktree.test.ts
```

Expected: planning is read-only, execution/testing use the worktree, rejection revises isolated changes, and testing approval promotes once.

- [ ] **Step 8: Commit orchestration integration**

```bash
git add packages/adapters/src/index.ts packages/orchestrator/src/index.ts packages/service/src/tools.ts tests/adapters-sdk.test.ts tests/orchestrator.test.ts tests/service.test.ts
git commit -m "feat: gate and promote isolated apply execution"
```

### Task 5: Synchronize Version And Checked-In Plugin Generation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/core/src/version.ts`
- Modify: `plugins/devcrew-codex/.codex-plugin/plugin.json`
- Modify: `plugins/devcrew-codex/.mcp.json`
- Modify: `plugins/devcrew-codex/agents/*.toml`
- Modify: `plugins/devcrew-codex/assets/logo.png`
- Modify: `scripts/smoke-codex-plugin.mjs`
- Modify: `tests/core.test.ts`
- Modify: `tests/plugins.test.ts`
- Test: `tests/package.test.ts`

- [ ] **Step 1: Write a failing checked-in plugin drift test**

Generate a fresh plugin and compare the tracked bundle:

```ts
test("checked-in Codex plugin matches the shared generator", async () => {
  const root = await tempProject();
  const generated = await generateCodexPlugin(root);
  const checkedIn = join(process.cwd(), "plugins", "devcrew-codex");
  const relativeFiles = [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "skills/devcrew/SKILL.md",
    "agents/pm.toml",
    "agents/architect.toml",
    "agents/implementer.toml",
    "agents/tester.toml",
    "assets/composer-icon.png",
    "assets/logo.png",
  ];

  for (const file of relativeFiles) {
    assert.deepEqual(
      await readFile(join(checkedIn, file)),
      await readFile(join(generated.path, file)),
      `${file} drifted from generateCodexPlugin`,
    );
  }
});
```

- [ ] **Step 2: Run the plugin drift test and verify RED**

```bash
node --import tsx --test --test-name-pattern="matches the shared generator" tests/plugins.test.ts
```

Expected: manifest version, role TOML, and logo differences are reported.

- [ ] **Step 3: Bump all shared version sources to 0.1.2**

Set:

```ts
export const DEVCREW_VERSION = "0.1.2";
```

Update root and lockfile package versions first:

```bash
npm version 0.1.2 --no-git-tag-version
```

Update test assertions and smoke client metadata to `0.1.2`. Regenerate the checked-in Codex plugin through `generateCodexPlugin` so manifest, MCP specifier, role templates, and binary assets come from one source:

```bash
node --import tsx --input-type=module -e 'import { generateCodexPlugin } from "./packages/plugins/src/index.ts"; await generateCodexPlugin(process.cwd());'
```

The generator command performs the asset synchronization; do not edit or copy plugin files separately afterward.

- [ ] **Step 4: Run package and plugin tests and verify GREEN**

```bash
node --import tsx --test tests/core.test.ts tests/package.test.ts tests/plugins.test.ts
```

Expected: package, shared constant, generated plugins, checked-in plugin, and npm runtime lock all report `0.1.2` with no drift.

- [ ] **Step 5: Commit version synchronization**

```bash
git add package.json package-lock.json packages/core/src/version.ts plugins/devcrew-codex scripts/smoke-codex-plugin.mjs tests/core.test.ts tests/plugins.test.ts tests/package.test.ts
git commit -m "chore: prepare DevCrew 0.1.2 plugin release"
```

### Task 6: Update Workflow Documentation And Run Full Verification

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/workflow.md`
- Modify: `docs/codex.md`

- [ ] **Step 1: Update user-facing flow documentation**

Document this exact apply sequence in English and Chinese:

```text
requirements approval
-> architecture approval
-> implementation plan approval
-> isolated execution
-> isolated testing
-> testing approval
-> patch promotion to requester repository
```

State that apply requires Git, a clean requester worktree at execution and promotion, a real host SDK backend, and one additional `devcrew_continue` call for `execution`. Explain that rejection feedback after testing returns the isolated run to execution without changing the requester repository.

Update every npm and plugin example to `@shenlee/devcrew@0.1.2`, but mark marketplace smoke as a post-publication check.

- [ ] **Step 2: Run the full validation suite**

```bash
npm run validate
```

Expected: TypeScript build succeeds and every test passes with zero failures.

- [ ] **Step 3: Inspect package contents with an isolated writable npm cache**

```bash
env npm_config_cache=/tmp/devcrew-npm-cache npm pack --dry-run --json
```

Expected: package name `@shenlee/devcrew`, version `0.1.2`, CLI dist files, docs, and `plugins/devcrew-codex` are present.

- [ ] **Step 4: Verify repository changes and generated plugin consistency**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intentional P0 implementation and documentation files are modified or committed.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md README.zh-CN.md docs/workflow.md docs/codex.md
git commit -m "docs: describe isolated apply execution"
```

- [ ] **Step 6: Stop before public marketplace publication**

Do not push the marketplace commit while `@shenlee/devcrew@0.1.2` is unavailable. Ask the requester to run:

```bash
npm publish --access public
```

After registry propagation, verify:

```bash
npm view @shenlee/devcrew version --registry https://registry.npmjs.org/
npm run smoke:codex-plugin
```

Expected: registry reports `0.1.2`, then the isolated Codex marketplace plan smoke passes. A real apply smoke remains manual because it consumes host-agent execution and modifies a fixture repository.

---

## Plan Self-Review

- Every P0 item in `docs/superpowers/specs/2026-07-10-p0-foundation-repair-design.md` maps to a task above.
- Public MCP tool and gate names remain unchanged.
- The only new persisted field is optional, so 0.1.1 states remain readable.
- Worktree capture and promotion use argument arrays, NUL-delimited paths, binary patches, clean requester preconditions, and no shell interpolation.
- The release plan prevents the marketplace from referencing npm `0.1.2` before publication.
- P1 semantic review, structured role output, configurable workflows, and Claude distribution remain out of scope.
