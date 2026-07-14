# P0 Verification and Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent unverified apply patches from being promoted and send architecture-review findings back through implementation.

**Architecture:** Keep `verificationStatus` as the single source for testing-gate policy. Treat `failed` and `not_run` identically for blocking, but allow the existing persisted waiver to reopen either state. Reuse the existing testing-rejection recovery pattern for implementation-review findings, preserving the isolated worktree while returning the state machine to `execution/ready`.

**Tech Stack:** TypeScript, Node.js test runner, Git worktrees, existing DevCrew MCP/orchestrator APIs.

---

### Task 1: Block missing verification evidence

**Files:**
- Modify: `tests/orchestrator.test.ts:483-533`
- Modify: `packages/orchestrator/src/index.ts:241-253, 552-558`
- Modify: `packages/core/src/workflow.ts:297-314`

- [ ] **Step 1: Write failing no-verification tests**

Add a test after the failed-verification test that creates an apply fixture with
an empty `verifyCommands` list and no discoverable manifest. Advance it through
testing and assert the following:

```ts
assert.equal(tested.verificationStatus, "not_run");
assert.equal(tested.gates.testing, "rejected");
assert.equal(tested.status, "awaiting_input");
await assert.rejects(
  () => approveOrchestratedWorkflow({ cwd, runId: tested.runId, gate: "testing" }),
  /not pending approval/i,
);
```

In the same test, call `waiveOrchestratedVerification` with a non-empty reason,
assert `testing: pending` and `awaiting_approval`, then approve testing and
assert the reviewed file was promoted. Add a second assertion that directly
sets a persisted test fixture to `verificationStatus: "not_run"`, a pending
testing gate, and no waiver, then expects `approveOrchestratedWorkflow` to
throw `Verification must pass before promotion`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --import tsx --test tests/orchestrator.test.ts
```

Expected: the new test fails because `not_run` currently opens a pending gate
and the waiver operation rejects it.

- [ ] **Step 3: Implement the minimal verification policy**

In `setTestingGateFromVerification`, replace the `failed`-only branch with a
non-passed branch. Preserve the existing failed message and add a distinct
missing-evidence message:

```ts
if (state.verificationStatus !== "passed") {
  state.gates.testing = "rejected";
  state.status = "awaiting_input";
  state.feedback.push({
    gate: "testing",
    message: state.verificationStatus === "failed"
      ? "Automated verification failed. Inspect the test report, revise the implementation, or record an explicit verification waiver with its reason."
      : "No verification evidence was recorded. Configure or run validation, revise the implementation, or record an explicit verification waiver with its reason.",
    createdAt: now(),
  });
  return;
}
```

Update `waiveVerificationWorkflow` to accept either `failed` or `not_run` and
change its error message to mention failed or missing verification. In
`approveOrchestratedWorkflow`, replace the failed-only promotion check with:

```ts
if (before.verificationStatus !== "passed" && !before.verificationWaiver) {
  throw new Error("Verification must pass before promotion or have an explicit verification waiver");
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
node --import tsx --test tests/orchestrator.test.ts
```

Expected: all orchestrator tests pass, including failed and missing
verification waiver paths.

- [ ] **Step 5: Commit the verification fix**

```bash
git add packages/core/src/workflow.ts packages/orchestrator/src/index.ts tests/orchestrator.test.ts
git commit -m "fix: block promotion without verification evidence"
```

### Task 2: Return review findings to execution

**Files:**
- Modify: `tests/orchestrator.test.ts:365-421`
- Modify: `packages/orchestrator/src/index.ts:639-658`
- Modify: `docs/workflow.md:45-49`

- [ ] **Step 1: Write the failing review-remediation test**

Extend `architecture review blocks testing when it requires changes` after its
current rejection assertions. Call `answerOrchestratedWorkflow` with a
non-empty answer and assert:

```ts
assert.equal(revised.phase, "execution");
assert.equal(revised.status, "ready");
assert.equal(revised.gates["implementation-review"], "not_started");
assert.equal(revised.executionWorkspace?.path, workspacePath);
```

Then call `continueOrchestratedWorkflow` with a runner that records its phase
and assert the next executed role has `phase === "execution"` and
`role === "implementer"`, not `review`/`architect`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --import tsx --test tests/orchestrator.test.ts
```

Expected: the new assertions fail because `devcrew_answer` currently re-runs
the review phase.

- [ ] **Step 3: Implement the remediation transition**

Add this branch in `answerOrchestratedWorkflow` immediately after the existing
testing-rejection branch:

```ts
if (
  before.executionMode === "apply" &&
  before.phase === "review" &&
  before.gates["implementation-review"] === "rejected" &&
  before.architectureReview?.decision === "changes_required"
) {
  state.phase = "execution";
  state.status = "ready";
  state.gates["implementation-review"] = "not_started";
  return saveState(state);
}
```

Do not clear `executionWorkspace`, `architectureReview`, feedback, or the
prior review artifact; they remain audit evidence and the next execution phase
will refresh the captured diff and create a new review.

- [ ] **Step 4: Update the workflow documentation**

Replace the current claim that feedback must be addressed before another review
with text stating that `devcrew_answer` returns the run to the isolated
`execution/ready` state and a later `devcrew_continue` performs the revised
implementation before a fresh architect review.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
node --import tsx --test tests/orchestrator.test.ts
```

Expected: all orchestrator tests pass and the remediation test observes an
implementer execution before a subsequent review.

- [ ] **Step 6: Commit the remediation fix**

```bash
git add docs/workflow.md packages/orchestrator/src/index.ts tests/orchestrator.test.ts
git commit -m "fix: return architecture findings to execution"
```

### Task 3: Full verification

**Files:**
- Verify: `packages/core/src/workflow.ts`
- Verify: `packages/orchestrator/src/index.ts`
- Verify: `tests/orchestrator.test.ts`

- [ ] **Step 1: Run the complete repository validation**

Run:

```bash
npm run validate
```

Expected: TypeScript compilation succeeds and every test passes.

- [ ] **Step 2: Inspect the final diff**

Run:

```bash
git diff main...HEAD --check
git status --short
```

Expected: no whitespace errors; only the two implementation commits and this
plan/spec commits are present on the branch.
