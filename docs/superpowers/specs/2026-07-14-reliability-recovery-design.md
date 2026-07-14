# Configuration Integrity and Run Recovery Design

## Goal

Reject unsafe DevCrew configuration before a workflow starts, serialize every
repository-mutating MCP operation, and give a requester an explicit, auditable
way to stop or recover an interrupted run without executing work automatically.

## Scope

This change covers configuration validation, repository mutation locking,
terminal aborted runs, `devcrew_abort`, and `devcrew_recover`. It does not add
automatic run resumption, change execution permissions, or introduce a remote
lock service.

## Configuration Contract

`readConfig` validates the complete version-1 shape rather than merging
untyped JSON into defaults.

- Top-level keys are limited to `version`, `defaultBackend`, `executionMode`,
  `verifyCommands`, `lintCommands`, `coverageCommands`, and `workflow`.
- `defaultBackend`, `executionMode`, and every workflow gate must be members
  of their exported enums.
- Command lists, when supplied, must be arrays of non-empty strings. Empty
  lists remain valid; omitted command lists retain their version-1 default of
  an empty array for backward compatibility.
- `workflow` may contain only `gates` and `artifactDirectory`; gates must be
  unique. The existing runtime rule still makes implementation review and
  testing mandatory.
- `artifactDirectory` must be a non-empty relative path whose resolved target
  is inside the requester repository. Absolute paths and traversal outside the
  repository are rejected before any artifact is written.

Unknown keys and invalid values fail closed with an error that names the
offending field. Existing default configuration remains valid.

## Repository Mutation Lock

All MCP operations that can write a run, active-run pointer, artifact, or
execution worktree take one repository-wide lock at `.devcrew/lock` for their
full operation. This includes start, answer, approve, reject, continue,
complete-execution, waive-verification, abort, and recovery cleanup. Status
and artifact reads remain unlocked.

The lock is an atomically-created directory containing owner metadata:
process id, a random owner id, and creation time. A second mutating request
does not wait or retry; it returns a clear busy error and cannot overwrite the
first operation's state. The holder removes only its own lock in `finally`.

Normal operations never remove a lock they did not create. A lock whose owner
metadata is absent, invalid, or refers to a non-running local process is
considered stale, but it still requires the explicit recovery operation to
remove it. This prevents a timeout heuristic from treating a long-running SDK
call as abandoned.

## Abort and Recovery Lifecycle

`RunStatus` gains terminal `aborted`, and `RunState` records an abort reason
and timestamp. An aborted run remains readable for audit but cannot continue,
approve, reject, answer, or complete execution. Repeating abort is idempotent
and preserves the first reason.

`devcrew_abort` accepts `cwd`, optional `runId`, and a non-empty `reason`.
Under the repository lock it records the abort, removes any isolated execution
worktree, and clears `active-run.json` only when it points at that run. If
worktree cleanup fails, the aborted state and audit evidence still persist;
the workspace reference remains for recovery.

`devcrew_recover` is explicit and never runs an agent or validation command.
It may remove a confirmed stale lock. When given a terminal run that retains
an execution workspace after an interrupted cleanup, it retries only that
worktree cleanup and clears the persisted workspace reference on success. A
live lock is never overridden.

## MCP and Error Semantics

The service exposes `devcrew_abort` and `devcrew_recover`. Both use the
existing optional-run-id resolution where applicable. Tool results retain the
current state summary; an aborted run reports `status=aborted`. Busy locks,
invalid configuration, live-lock recovery, and invalid abort/recovery targets
return normal structured MCP errors.

## Tests

- Config tests cover unknown fields, invalid enum/gate/command values,
  duplicate gates, absolute artifact directories, and parent traversal.
- Service tests cover lock contention between mutation calls, while reads stay
  available.
- Orchestrator/service tests cover abort audit persistence, worktree cleanup,
  active-run clearing, idempotency, terminal-state blocking, stale-lock
  recovery, and recovery cleanup after a simulated failed abort cleanup.
