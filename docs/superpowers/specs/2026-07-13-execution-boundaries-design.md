# DevCrew Execution Boundaries Design

## Goal

Make DevCrew's approval, verification, and role boundaries match its public
product claims. Interactive work must execute through the host agent's native
permission model. Headless work may use host SDKs only under an explicit,
auditable DevCrew execution policy.

## Scope

This change is delivered in three independently releasable slices:

1. Safety semantics: explicit execution policy and verification-failure
   promotion blocking.
2. Workflow semantics: execution-time architecture compliance review and
   structured role questions/results.
3. Productisation: effective artifact configuration and real-host integration
   coverage.

The existing isolated Git worktree and binary patch promotion remain the sole
mechanism for moving apply-mode changes into the requester repository.

## Execution Planes

### Interactive host plane

Interactive Codex and Claude Code workflows do not invoke the Codex or Claude
SDK to modify repository files. DevCrew MCP owns durable workflow state,
artifacts, gate validation, execution worktree creation, patch capture, and
promotion. It exposes a structured execution instruction containing the role,
worktree path, approved context, and required result schema. The active host
agent or a native host subagent performs the work with the host's ordinary
sandbox and approval UI, then submits the result to DevCrew.

This plane must never claim that a nested SDK session inherits the interactive
host's current approval decisions.

### Headless SDK plane

Headless and CI workflows retain SDK orchestration, but `apply` requires an
explicit `executionPolicy`. The initial policy set is:

- `interactive-host`: no nested SDK execution; valid only for an interactive
  host integration.
- `headless-restricted`: SDK execution in the DevCrew worktree with a declared
  minimal tool surface and no hidden user-prompt assumption.
- `headless-unattended`: an explicitly opted-in unattended SDK policy for CI;
  its audit record makes the autonomy clear.

The policy, backend, allowed capabilities, and any waiver are recorded in run
state and shown in review artifacts. `acceptEdits`, bare `allowedTools`, and an
implicit Codex approval policy are not described as inherited host approvals.

## Verification And Promotion

After isolated testing, DevCrew computes a verification status:

- `passed`: every configured or discovered verification command exited zero.
- `failed`: at least one command exited nonzero or timed out.
- `not_run`: no verification command was available.

Only `passed` can open the normal `testing` approval gate. A failed result
moves the run to `awaiting_input` with the failure evidence and preserves the
worktree. A requester may either supply feedback that returns the run to
`execution`, or invoke a dedicated risk-waiver operation with a non-empty
reason. The waiver is persistent, appears in the test report and acceptance
artifact, and is the only path that can open a testing approval gate after a
failed verification.

`not_run` remains reviewable but is visibly distinct from `passed`; it cannot
be silently represented as successful verification.

## Execution-Time Architecture Review

The current implementation-plan gate approves a plan and cannot approve the
subsequent code diff. Add an `implementation-review` gate after execution and
before testing. The architect role receives the approved architecture artifact,
captured binary diff, changed-file list, lint evidence, and structured
implementation result. It returns a structured compliance decision.

Only an approved implementation review advances to testing. Rejection records
feedback and returns to execution with the existing isolated worktree intact.
The existing `implementation-review.md` remains an artifact, but becomes the
architect's real review output rather than a rendered checklist.

## Structured Role Results And Clarification

Each role result is a validated JSON envelope with a Markdown body plus
role-specific fields. At minimum, PM returns `questions`, architect returns a
compliance decision, implementer returns changed-file and command evidence, and
tester returns case/evidence summaries. Markdown remains the human-facing
artifact format.

If PM returns one or more questions, requirements enter `awaiting_input`
without opening an approval gate. `devcrew_answer` records the answer and
re-runs PM. A requirements gate opens only when the PM result has no open
questions.

## Configuration

`workflow.artifactDirectory` is used by all artifact path helpers, relative to
the repository root and validated to remain within that root. Core safety gates
are not freely removable. `workflow.gates` is replaced or constrained by a
validated sequence that must include requirements, architecture,
implementation, implementation-review, and testing for apply workflows.

## Integration Coverage

Add tests for failed verification, risk waiver, no-verification status,
architecture-review rejection/revision, structured PM questions, and configured
artifact output. Preserve existing worktree-promotion coverage.

The production-like Codex marketplace smoke remains plan-mode and must verify
the published package version. Add isolated integration coverage for the
interactive execution handoff protocol and a real Claude plugin install/start
smoke. A real unattended apply smoke uses only a disposable fixture repository
and an explicitly selected headless policy.

## Non-goals

- Do not remove worktree isolation or binary patch promotion.
- Do not automatically approve failed verification.
- Do not make arbitrary workflow graph customisation part of this release.
- Do not use generated role files as an execution mechanism until a host-native
  integration consumes them explicitly.
