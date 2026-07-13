# Safety Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make apply-mode execution policy explicit and prevent failed or absent verification from silently promoting an isolated patch.

**Architecture:** Add a persistent execution policy and verification outcome to the workflow state. Interactive apply runs pause with a host-execution handoff instead of launching a nested SDK; explicitly selected headless policies retain SDK execution with declared permissions. Testing only opens a normal promotion gate after successful verification; a separate waiver records the reason before an exception can be approved.

**Tech Stack:** TypeScript, Node.js test runner, MCP JSON-RPC tools, Git worktrees.

---

## File Structure

- Modify: `packages/core/src/types.ts` — policy, verification, handoff, and waiver state contracts.
- Modify: `packages/core/src/validation.ts` — parse policy and waiver input.
- Modify: `packages/core/src/workflow.ts` — default/apply-policy invariants and waiver transition.
- Modify: `packages/core/src/store.ts` — migrate persisted legacy runs safely.
- Modify: `packages/adapters/src/index.ts` — explicit headless SDK options; no implicit approval inheritance.
- Modify: `packages/orchestrator/src/index.ts` — interactive execution pause/submission and verification gate blocking.
- Modify: `packages/service/src/tools.ts` — MCP schemas and handlers for execution completion and verification waiver.
- Modify: `packages/core/src/artifacts.ts` — render policy, verification status, and waiver evidence.
- Modify: `tests/core.test.ts`, `tests/adapters-sdk.test.ts`, `tests/orchestrator.test.ts`, `tests/service.test.ts` — red/green coverage for every new state transition.
- Modify: `README.md`, `docs/workflow.md`, `docs/codex.md`, `docs/claude-code.md`, `packages/plugins/src/index.ts` — correct public behavior and generated skill copy.

### Task 1: Persist explicit execution and verification semantics

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/validation.ts`
- Modify: `packages/core/src/store.ts`
- Test: `tests/core.test.ts`

- [ ] **Step 1: Write failing state-contract tests**

Add tests that start an apply workflow with `executionPolicy: "headless-restricted"`, assert the policy persists through `loadState`, and assert unknown policy values fail validation. Add a migration fixture without the new fields and assert it loads as an interactive-host apply run with `verificationStatus: "not_run"` and no waiver.

```ts
assert.equal(state.executionPolicy, "headless-restricted");
await assert.rejects(
  () => startWorkflow({ ...input, executionMode: "apply", executionPolicy: "unsafe" }),
  /executionPolicy/,
);
assert.equal(loaded.verificationStatus, "not_run");
```

- [ ] **Step 2: Run the focused core test and verify RED**

Run: `node --import tsx --test tests/core.test.ts`

Expected: FAIL because `executionPolicy` and `verificationStatus` are not yet represented in state or input validation.

- [ ] **Step 3: Add the minimal state and parsing contracts**

In `types.ts`, add:

```ts
export const EXECUTION_POLICIES = ["interactive-host", "headless-restricted", "headless-unattended"] as const;
export type ExecutionPolicy = (typeof EXECUTION_POLICIES)[number];
export type VerificationStatus = "not_run" | "passed" | "failed";

export interface VerificationWaiver { reason: string; createdAt: string; }
```

Add `executionPolicy` to `StartWorkflowInput` and `RunState`, plus
`verificationStatus` and optional `verificationWaiver` to `RunState`. Add
`parseExecutionPolicy()` and `parseWaiverReason()` in `validation.ts`. In
`loadState`, use `interactive-host` for legacy apply runs and `not_run` for
missing verification status.

- [ ] **Step 4: Run the focused core test and verify GREEN**

Run: `node --import tsx --test tests/core.test.ts`

Expected: PASS, including new persistence and invalid-policy cases.

- [ ] **Step 5: Commit the state contract**

```bash
git add packages/core/src/types.ts packages/core/src/validation.ts packages/core/src/store.ts tests/core.test.ts
git commit -m "feat: record execution and verification policy"
```

### Task 2: Make SDK execution explicitly headless

**Files:**
- Modify: `packages/adapters/src/index.ts`
- Test: `tests/adapters-sdk.test.ts`

- [ ] **Step 1: Write failing adapter-policy tests**

Replace the assertion that Claude apply uses `acceptEdits` with tests proving
that an interactive-host execution is rejected before SDK invocation and that
headless policies select explicit SDK options. For Claude restricted mode, the
test must assert `permissionMode: "dontAsk"` and a narrow tool list. For Codex,
assert `approvalPolicy: "never"` only for `headless-unattended` and no implicit
approval-policy value for read-only planning.

```ts
await assert.rejects(
  () => runRole({ ...baseInput, phase: "execution", executionMode: "apply", executionPolicy: "interactive-host", backend: "claude" }),
  /interactive-host execution must be performed by the host/,
);
```

- [ ] **Step 2: Run the focused adapter test and verify RED**

Run: `node --import tsx --test tests/adapters-sdk.test.ts`

Expected: FAIL because `RoleRunInput` lacks the policy and Claude currently
sets `acceptEdits` with bare `Bash` permission.

- [ ] **Step 3: Implement explicit headless profiles**

Add `executionPolicy` to `RoleRunInput`. Make `roleCanApply()` require a
headless policy. Reject SDK execution for `interactive-host`. Replace the
Claude restricted profile with `dontAsk`: implementers receive only `Read`,
`Grep`, `Glob`, `Edit`, and `Write`; testers receive only `Read`, `Grep`, and
`Glob`. Neither restricted role receives `Bash`; DevCrew's configured command
runner supplies verification evidence separately. For the explicitly selected
unattended policy, add the SDK's dangerous-skip opt-in and set Claude to
`bypassPermissions`; this is an auditable CI-only policy. Pass Codex
`approvalPolicy: "never"` only for that unattended policy. Document that both
headless profiles are DevCrew policies, not inherited host approval.

- [ ] **Step 4: Run the focused adapter test and verify GREEN**

Run: `node --import tsx --test tests/adapters-sdk.test.ts`

Expected: PASS with no `acceptEdits` assertion remaining.

- [ ] **Step 5: Commit the adapter boundary**

```bash
git add packages/adapters/src/index.ts tests/adapters-sdk.test.ts
git commit -m "fix: make SDK apply policies explicit"
```

### Task 3: Add the interactive execution handoff

**Files:**
- Modify: `packages/orchestrator/src/index.ts`
- Modify: `packages/service/src/tools.ts`
- Test: `tests/orchestrator.test.ts`
- Test: `tests/service.test.ts`

- [ ] **Step 1: Write failing handoff tests**

Add an apply workflow with `executionPolicy: "interactive-host"`. After the
implementation gate is approved, `devcrew_continue` must create the isolated
worktree but not call the injected `RoleRunner`; it returns
`status: "awaiting_execution"` and structured instruction data. A new
`devcrew_complete_execution` call captures the worktree patch and advances to
testing without modifying the requester repository. Repeat the same handoff
for the tester: it receives the test-report instruction, returns exact command
result records, and DevCrew derives the verification status from those records.

```ts
assert.equal(paused.status, "awaiting_execution");
assert.equal(runnerCalls.filter((call) => call.phase === "execution").length, 0);
assert.equal(paused.executionInstruction?.cwd, paused.executionWorkspace?.path);
```

- [ ] **Step 2: Run focused orchestrator and service tests and verify RED**

Run: `node --import tsx --test tests/orchestrator.test.ts tests/service.test.ts`

Expected: FAIL because the current orchestrator immediately invokes the SDK
runner and no completion MCP tool exists.

- [ ] **Step 3: Implement pause and completion transitions**

Add `awaiting_execution` to `RunStatus` and an `ExecutionInstruction` state
object containing role, phase, worktree cwd, request, standards, approved
artifacts, and required result sections. In the execution and testing branches
of `runCurrentPhaseRole`, ensure the worktree, write the instruction, persist
the state, and return without calling `runner` or `runConfiguredVerification`
when policy is `interactive-host`.

Add `completeInteractiveExecution(input)` to orchestrator. It requires an
`awaiting_execution` state and a required Markdown summary supplied by the
host. For execution it captures changes, runs no nested SDK or shell command,
writes implementation-review evidence, and moves to `testing/ready`. For
testing it accepts a validated array of `{ command, exitCode, output,
startedAt, completedAt }`, writes the test report, derives the verification
status, and either opens the gate or enters the failure path. Expose it as
`devcrew_complete_execution` with an input schema that includes `summary` and
optional `verification` records.

- [ ] **Step 4: Run focused handoff tests and verify GREEN**

Run: `node --import tsx --test tests/orchestrator.test.ts tests/service.test.ts`

Expected: PASS; the requester repository remains unchanged until a later
testing approval.

- [ ] **Step 5: Commit the interactive handoff**

```bash
git add packages/orchestrator/src/index.ts packages/service/src/tools.ts tests/orchestrator.test.ts tests/service.test.ts
git commit -m "feat: hand interactive apply execution to host"
```

### Task 4: Block failed verification and require a recorded waiver

**Files:**
- Modify: `packages/core/src/workflow.ts`
- Modify: `packages/orchestrator/src/index.ts`
- Modify: `packages/service/src/tools.ts`
- Modify: `packages/core/src/artifacts.ts`
- Test: `tests/orchestrator.test.ts`
- Test: `tests/service.test.ts`

- [ ] **Step 1: Write failing verification tests**

Create an apply fixture with `verifyCommands: ["node -e \"process.exit(7)\""]`.
After testing, assert `verificationStatus === "failed"`, `status ===
"awaiting_input"`, and that `approveOrchestratedWorkflow({ gate: "testing" })`
rejects without promoting the patch. Add a second test showing that
`devcrew_waive_verification` rejects an empty reason, persists a non-empty
reason, reopens the testing gate, and permits promotion only after normal
testing approval.

```ts
await assert.rejects(
  () => approveOrchestratedWorkflow({ cwd, runId, gate: "testing" }),
  /verification failed/,
);
assert.equal(waived.verificationWaiver?.reason, "Known upstream test outage");
```

- [ ] **Step 2: Run focused workflow tests and verify RED**

Run: `node --import tsx --test tests/orchestrator.test.ts tests/service.test.ts`

Expected: FAIL because a nonzero command currently still opens the pending
testing gate and no waiver tool exists.

- [ ] **Step 3: Implement verification outcome and waiver flow**

After `runConfiguredVerification`, set `verificationStatus` from every result:
empty is `not_run`, all-zero is `passed`, otherwise `failed`. A failed status
sets `awaiting_input` and does not set the testing gate to pending. Add
`waiveVerification(input)` that requires failed verification and a non-empty
reason, records `VerificationWaiver`, changes the testing gate to pending, and
sets `awaiting_approval`. Add `devcrew_waive_verification` to the MCP schema
and handler.

Make `approveOrchestratedWorkflow` reject a testing promotion unless status is
passed or a waiver exists. Render the status, command exit evidence, and waiver
reason in both the test report and acceptance artifact.

- [ ] **Step 4: Run focused verification tests and verify GREEN**

Run: `node --import tsx --test tests/orchestrator.test.ts tests/service.test.ts`

Expected: PASS; failed verification cannot mutate the requester repository,
while a recorded waiver remains visible and permits intentional approval.

- [ ] **Step 5: Commit verification safety**

```bash
git add packages/core/src/workflow.ts packages/orchestrator/src/index.ts packages/service/src/tools.ts packages/core/src/artifacts.ts tests/orchestrator.test.ts tests/service.test.ts
git commit -m "fix: block failed verification promotion"
```

### Task 5: Correct generated instructions and user-facing documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/workflow.md`
- Modify: `docs/codex.md`
- Modify: `docs/claude-code.md`
- Modify: `packages/plugins/src/index.ts`
- Test: `tests/plugins.test.ts`

- [ ] **Step 1: Write failing generated-skill/doc assertions**

Extend plugin tests to require the generated skill to distinguish
interactive-host execution from headless policy and to mention
`devcrew_complete_execution` and `devcrew_waive_verification`.

- [ ] **Step 2: Run plugin tests and verify RED**

Run: `node --import tsx --test tests/plugins.test.ts`

Expected: FAIL because the generated skill promises inherited host approvals
and lacks the new handoff/waiver tools.

- [ ] **Step 3: Update generated skill and docs**

Document that interactive host execution uses the host's native agent after
DevCrew supplies a worktree instruction; it does not run a nested SDK. Document
headless policies as explicit DevCrew policies. Replace all claims that DevCrew
inherits a current host approval boundary. Add the failed-verification and
recorded-waiver transition to workflow diagrams and tool lists.

- [ ] **Step 4: Run plugin tests and verify GREEN**

Run: `node --import tsx --test tests/plugins.test.ts`

Expected: PASS with the checked-in plugin matching regenerated text.

- [ ] **Step 5: Run full validation and commit documentation**

Run: `npm run validate`

Expected: exit code 0 with all tests passing.

```bash
git add README.md docs/workflow.md docs/codex.md docs/claude-code.md packages/plugins/src/index.ts plugins/devcrew-codex plugins/devcrew-claude tests/plugins.test.ts
git commit -m "docs: describe explicit apply execution policies"
```
