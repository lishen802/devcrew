# DevCrew P0 Foundation Repair Design

## Objective

Repair the P0 workflow and execution-safety defects identified in the 0.1.1 review without expanding into the P1 role-model, semantic architecture review, or configurable workflow work.

The repaired workflow must guarantee that requester approval happens before code changes, apply-mode changes remain isolated until final approval, malformed MCP input cannot poison the server, gate mutations are valid and idempotent, local fallback cannot impersonate apply execution, and the checked-in plugin cannot drift from the package version.

## Scope

This design includes:

- Move real implementation after the existing `implementation` gate.
- Execute apply-mode implementation and verification in a run-owned Git worktree.
- Capture committed, staged, unstaged, renamed, deleted, binary, and new-file changes as one reviewable patch.
- Apply the reviewed patch to the requester's repository only after the `testing` gate is approved.
- Keep rejected testing work isolated and allow the implementer to revise it.
- Enforce legal, idempotent `approve`, `reject`, and `answer` transitions.
- Validate JSON-RPC request shape and recover the stdio queue after handler failures.
- Reject `executionMode=apply` with the `local` backend.
- Synchronize package, generated plugin, checked-in plugin, and MCP runtime versions.

This design does not include:

- Real architect-driven semantic diff review.
- Structured PM questions and machine-readable role verdicts.
- Host-native role/subagent integration.
- Configurable gates or artifact directories.
- Claude marketplace packaging or smoke coverage.
- Cross-process run locking or HTTP transport.

## Workflow Model

The public gate names remain unchanged for MCP compatibility:

1. `requirements`
2. `architecture`
3. `implementation`
4. `testing`

The internal phase sequence becomes:

```text
requirements
  -> architecture
  -> implementation
  -> execution (apply only)
  -> testing
  -> acceptance
  -> complete
```

The existing `implementation` phase becomes plan-only in both execution modes. The implementer receives a read-only role prompt and writes `implementation-plan.md`. Approving the `implementation` gate advances plan mode directly to `testing`, while apply mode advances to the new nongated `execution` phase.

The `execution` phase runs the implementer in an isolated worktree, writes `implementation-review.md`, and advances to `testing` with status `ready`. The next `continue` runs the tester and verification commands in the same worktree, then opens the `testing` gate.

Approving the `testing` gate applies the captured patch to the original repository, removes the worktree, and advances to acceptance. Rejecting the testing gate leaves the worktree isolated. The rejection feedback can be answered, after which the run returns to `execution` so the implementer can revise the existing isolated changes.

## Apply Isolation

### Workspace creation

Before the first execution attempt DevCrew must:

1. Confirm the requester repository is a Git repository with a clean working tree, excluding DevCrew runtime and artifact paths.
2. Record the current `HEAD` as `baseCommit`.
3. Create a detached worktree under `.devcrew/worktrees/<run-id>`.
4. Persist the worktree path and base commit before invoking the SDK role.

All implementation, lint, test, and coverage commands run with the worktree as their working directory. Artifacts and state remain in the original repository.

### Capturing all changes

After the implementer returns DevCrew must normalize any commits created by the role back into worktree changes relative to `baseCommit`. This is safe because the worktree is owned by the run and has not been promoted.

DevCrew then marks untracked files as intent-to-add inside the worktree and captures:

- `git status --porcelain=v1 -z -uall` for changed paths.
- `git diff --binary --no-ext-diff <baseCommit> --` for the complete patch.

Using the base commit includes staged and unstaged changes. Intent-to-add makes new files visible in the patch. NUL-delimited status parsing avoids filename quoting and rename parsing bugs.

### Promotion

Before applying an approved patch DevCrew must re-check that the requester repository is clean and still points at `baseCommit`. If either condition changed, approval fails without deleting the worktree or mutating the requester repository.

Promotion writes the captured patch under the run directory, applies it to the requester repository with `git apply --binary`, verifies the resulting requester diff matches the reviewed patch, and then removes the worktree. The promoted files remain uncommitted so the requester retains normal review and commit control.

An empty apply patch is an error. Apply mode must never report successful implementation when no repository change was produced.

## State Changes

`RunState` gains optional execution workspace metadata:

```ts
interface ExecutionWorkspace {
  path: string;
  baseCommit: string;
}
```

The `execution` phase is added to `PHASES`. Older state files without execution workspace metadata continue to load.

Gate mutations use these rules:

- Approving an already approved gate returns the unchanged state and does not append another approval.
- Rejecting an already rejected gate returns the unchanged state and does not append duplicate feedback.
- A pending gate can only be approved or rejected when it is the current phase gate and status is `awaiting_approval`.
- `answer` is only legal while status is `awaiting_input` and the current gate is rejected.
- Calls against `acceptance` or `complete` cannot move the run backwards.

The service uses a new orchestrated approval entry point so testing approval can promote the patch before the core state advances.

## Backend Rules

After host/config backend resolution, workflow creation rejects this combination:

```text
executionMode=apply, backend=local
```

Plan mode keeps deterministic local fallback. Apply mode requires a real Codex or Claude SDK backend at every role phase.

The implementation-plan role is forced to read-only behavior even when the run execution mode is apply. Only the new execution phase and apply-mode tester receive write/Bash capabilities.

## Stdio Reliability

The line processor validates that parsed JSON is a non-array object with `jsonrpc: "2.0"` and a string `method`. Invalid request objects receive JSON-RPC error `-32600` with `id: null` and do not enter the request queue.

For queued requests, each returned task may reject to its caller, but the internal queue stores a recovered promise. One handler failure therefore cannot prevent later requests from executing.

Existing parse error behavior remains `-32700`. Notifications without an ID remain response-free.

## Version Discipline

The next implementation version is `0.1.2`. The following must agree:

- `package.json`
- `package-lock.json`
- `DEVCREW_VERSION`
- generated Codex and Claude manifests
- checked-in Codex manifest
- checked-in Codex MCP npm package specifier
- smoke client metadata and version assertions

CI adds a checked-in plugin drift test that generates a fresh Codex plugin in a temporary directory and compares all generated text files with the checked-in bundle. Binary assets are checked by hash. Publication order is npm `0.1.2` first, then marketplace push, so the public plugin never references an unavailable npm version.

## Error Handling

- Worktree creation failure leaves the run in `execution/ready` with no role result recorded.
- SDK failure leaves the isolated worktree available for diagnosis and retry.
- Empty implementation patch fails before testing.
- Verification failures remain visible in the testing artifact; automatic test verdict blocking remains P1.
- Promotion precondition failure leaves the worktree and state intact for manual resolution.
- Worktree cleanup runs only after successful promotion or explicit run rejection cleanup added in a later lifecycle feature.

## Testing Strategy

Tests are added before implementation and must demonstrate the original failures:

- Implementation-plan approval occurs before the first writable role invocation.
- Local apply start is rejected.
- An implementer-created commit is converted into a complete reviewed patch.
- Staged, unstaged, renamed, deleted, binary, and untracked files appear in review evidence.
- Rejecting testing keeps changes outside the requester repository and supports revision.
- Approving testing promotes exactly the reviewed patch.
- Changed requester `HEAD` or dirty requester worktree blocks promotion.
- Empty apply output fails.
- Duplicate approvals/rejections are idempotent.
- Complete runs cannot be reopened.
- Answer outside `awaiting_input` fails.
- JSON `null`, arrays, missing methods, and wrong JSON-RPC versions return `-32600`.
- A rejected request handler does not block the next stdio request.
- Checked-in plugin version and generated bundle match `DEVCREW_VERSION`.

The final verification command remains `npm run validate`, followed by the isolated Codex marketplace smoke after `@shenlee/devcrew@0.1.2` is published.

## Compatibility

MCP tool names and gate names remain stable. Existing plan-mode callers continue using the same approve/continue sequence. Apply-mode sequencing gains one additional `continue` call for the execution phase before testing.

Existing 0.1.1 run files remain loadable. Runs already in the old `implementation` phase are treated as implementation planning and cannot write code until their implementation gate is approved under the new state transition.
