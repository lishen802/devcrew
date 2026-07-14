# Configuration Integrity and Run Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject unsafe configuration, prevent concurrent MCP mutations from overwriting one another, and make interrupted runs explicitly abortable and recoverable.

**Architecture:** A strict version-1 parser validates `.devcrew/config.json` and keeps artifact paths inside the requester repository. A repository-wide atomic directory lock wraps MCP mutations while read-only calls remain available. Aborting is a persisted terminal state that preserves audit data; recovery only clears a confirmed stale lock and retries cleanup of a terminal run's residual worktree.

**Tech Stack:** TypeScript, Node.js `fs/promises`, Node test runner, Git worktrees, MCP tool registry.

---

### Task 1: Validate configuration and artifact paths

**Files:**
- Modify: `packages/core/src/config.ts`
- Modify: `tests/core.test.ts`

- [ ] **Step 1: Write failing configuration tests**

Add table-driven tests that write `.devcrew/config.json`, then call
`startWorkflow`. Cover an unknown top-level key, an unknown workflow key, an
unknown gate, a duplicate gate, an empty command, an absolute
`artifactDirectory`, and `../outside`. Each test asserts the error identifies
the invalid field. Add a valid custom artifact directory assertion so the
existing supported path remains accepted.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --import tsx --test tests/core.test.ts
```

Expected: new invalid-config cases fail because `readConfig` currently merges
untyped JSON and `artifactDirectory` is only joined to `cwd`.

- [ ] **Step 3: Implement a strict version-1 parser**

In `config.ts`, parse JSON as `unknown`, require plain objects, reject keys
outside the documented schema, validate enum values from exported type
constants, and validate arrays as non-empty trimmed strings with no invalid
gate entries or duplicates. Resolve `workflow.artifactDirectory` against
`cwd`; reject absolute values and any resolved path whose relative path leaves
the repository. Return the normalized validated `DevCrewConfig`.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
node --import tsx --test tests/core.test.ts
git add packages/core/src/config.ts tests/core.test.ts
git commit -m "fix: validate DevCrew configuration strictly"
```

Expected: all core tests pass and invalid configuration fails before a run is
created.

### Task 2: Add explicit repository mutation locks

**Files:**
- Create: `packages/core/src/lock.ts`
- Modify: `packages/core/src/paths.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/service/src/tools.ts`
- Modify: `tests/core.test.ts`
- Modify: `tests/service.test.ts`

- [ ] **Step 1: Write failing lock tests**

Add core tests that hold a repository lock while a second acquisition rejects
with a busy error, then release the first lock and acquire again. Create a
lock directory with metadata containing a non-running pid and assert normal
acquisition still refuses it while explicit stale-lock recovery removes it.
Add a service test that holds the lock, verifies `devcrew_status` still works,
and verifies a mutating `devcrew_approve` returns a structured busy error.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --import tsx --test tests/core.test.ts tests/service.test.ts
```

Expected: imports fail because no repository lock API exists and MCP calls do
not serialize mutations.

- [ ] **Step 3: Implement lock primitives**

Add `repositoryLockPath`, then implement `withRepositoryLock(cwd, action)`
using atomic `mkdir`. Store `{ ownerId, pid, createdAt }` in `lock.json`,
remove only the held owner directory in `finally`, and reject existing locks
without waiting. Implement `recoverRepositoryLock(cwd)` to remove only a
missing/invalid/dead-local-process lock; it must reject a live owner and must
never run automatically.

- [ ] **Step 4: Wrap MCP mutation dispatch**

In `callDevCrewTool`, route start, answer, approve, reject, continue,
complete-execution, waive-verification, abort, and recovery cleanup through a
single lock wrapper. Resolve an omitted run id inside the lock. Keep status and
artifact calls unlocked. Ensure start creates its run and sets `active-run`
under one lock.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
node --import tsx --test tests/core.test.ts tests/service.test.ts
git add packages/core/src/lock.ts packages/core/src/paths.ts packages/core/src/index.ts packages/service/src/tools.ts tests/core.test.ts tests/service.test.ts
git commit -m "fix: serialize DevCrew MCP mutations"
```

Expected: concurrent writes return a structured busy error and reads remain
available.

### Task 3: Persist terminal aborts and recover residual worktrees

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/active-run.ts`
- Modify: `packages/core/src/workflow.ts`
- Modify: `packages/orchestrator/src/index.ts`
- Modify: `packages/service/src/tools.ts`
- Modify: `docs/workflow.md`
- Modify: `tests/core.test.ts`
- Modify: `tests/orchestrator.test.ts`
- Modify: `tests/service.test.ts`

- [ ] **Step 1: Write failing abort and recovery tests**

Add a workflow test that aborts a nonterminal state with a reason, asserts
`status: "aborted"`, persisted reason/timestamp, and that continue/answer/
complete cannot resume it. Add an apply-worktree test that aborts after
execution, confirms the requester checkout is unchanged and the isolated
worktree is removed. Add a service test that `devcrew_abort` clears its active
run and that a repeated abort is idempotent. Add a recovery test for an
aborted state retaining a workspace reference: recovery cleans that worktree
and clears the reference without running a role.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --import tsx --test tests/core.test.ts tests/orchestrator.test.ts tests/service.test.ts
```

Expected: tests fail because `aborted` is not a run status and no abort or
recovery tool exists.

- [ ] **Step 3: Implement terminal abort state**

Add `RunAbort` plus `RunStatus: "aborted"`; persist the first non-empty abort
reason and timestamp. Add `abortWorkflow` with terminal idempotency, and make
continuation return aborted runs unchanged. Add
`clearActiveRunIfMatches(cwd, runId)` so an abort never clears another run's
active pointer.

- [ ] **Step 4: Implement orchestration and MCP lifecycle tools**

Add `abortOrchestratedWorkflow` to persist abort audit state before attempting
worktree cleanup. On cleanup success clear `executionWorkspace`; on failure
leave it for recovery. Add `recoverOrchestratedWorkflow` that accepts only
terminal runs and retries this cleanup. Register `devcrew_abort` and
`devcrew_recover`, with schemas and structured errors, and apply the lock
rules from Task 2. Update `docs/workflow.md` with abort/recover semantics.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
node --import tsx --test tests/core.test.ts tests/orchestrator.test.ts tests/service.test.ts
git add packages/core/src/types.ts packages/core/src/active-run.ts packages/core/src/workflow.ts packages/orchestrator/src/index.ts packages/service/src/tools.ts docs/workflow.md tests/core.test.ts tests/orchestrator.test.ts tests/service.test.ts
git commit -m "feat: add DevCrew abort and recovery controls"
```

Expected: aborted runs retain audit evidence, cannot resume, clean their
worktrees when possible, and can explicitly retry residual cleanup.

### Task 4: Full verification

**Files:**
- Verify: all modified files

- [ ] **Step 1: Run repository validation**

```bash
npm run validate
```

Expected: TypeScript build succeeds and every test passes.

- [ ] **Step 2: Inspect final state**

```bash
git diff main...HEAD --check
git status --short
git log --oneline main..HEAD
```

Expected: no whitespace errors, clean worktree, and only the design, plan,
and implementation commits on the branch.
