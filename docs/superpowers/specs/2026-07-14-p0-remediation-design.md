# P0 Verification and Review Remediation Design

## Goal

Close two apply-mode safety gaps: a run with no verification evidence must not
be promoted without an explicit waiver, and an architecture review that requires
changes must return to implementation before it can be reviewed again.

## Verification Gate Semantics

`passed` is the only verification status that opens the normal `testing` gate.
Both `failed` and `not_run` set the testing gate to `rejected` and move the run
to `awaiting_input` with evidence explaining the condition.

The existing `devcrew_waive_verification` operation is the sole exception path
for either `failed` or `not_run`. It requires a non-empty requester risk reason,
persists the waiver, and reopens the testing gate. Promotion additionally
defends this invariant: any status other than `passed` requires a recorded
waiver, even if an invalid state was written by an older client.

## Architecture Review Remediation

When the architect returns `changes_required`, DevCrew continues to record the
decision, artifact, and feedback, while keeping the isolated execution
worktree. The implementation-review gate becomes `rejected` and the run enters
`awaiting_input`.

After `devcrew_answer`, DevCrew records the response then transitions the same
run to `execution/ready`. It resets the implementation-review gate to
`not_started`; it does not run another architect review. A subsequent
`devcrew_continue` invokes the implementer in the existing worktree, captures a
new diff, and schedules a fresh architecture review. This mirrors the existing
testing-rejection remediation flow.

## Error Handling and Compatibility

Existing persisted runs remain readable. A legacy run with `not_run` cannot be
promoted unless it has a waiver. The waiver tool's error message and validation
are expanded from "failed verification" to "failed or missing verification".
No new MCP tool or public state field is required.

## Acceptance Tests

1. Apply-mode testing with no discovered or configured commands results in
   `verificationStatus: not_run`, `testing: rejected`, and `awaiting_input`.
2. A non-empty waiver can reopen that `not_run` testing gate; an empty reason or
   a run outside `failed`/`not_run` is rejected.
3. Promotion rejects `not_run` without a waiver even if a caller manufactured a
   pending testing gate.
4. An architect `changes_required` decision followed by `devcrew_answer`
   transitions to `execution/ready` in the existing worktree, and the next
   continuation invokes the implementer rather than the architect.
