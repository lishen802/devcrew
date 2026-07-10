# Workflow Model

DevCrew uses a gated state machine plus an orchestrator layer.

The core state machine persists run state and gate transitions. The orchestrator
executes the role for the current phase, writes that role's Markdown artifact,
records the role result in state, and then opens the phase gate for requester
approval.

## Modes

- `feature`: existing repository work. The workflow emphasizes current conventions, code review, and regression tests.
- `greenfield`: new product work. The workflow emphasizes product boundary, minimal architecture, and a shippable first slice.

## Phases

1. `requirements`: product manager clarifies scope, users, success criteria, and non-goals.
2. `architecture`: architect defines technical approach, interfaces, deployment notes, and review criteria.
3. `implementation`: implementer creates a read-only implementation plan and coding checklist. The implementation gate approves this plan, not repository changes.
4. `execution`: internal, nongated apply phase. The implementer works in `.devcrew/worktrees/<run-id>`, and DevCrew captures changed files, a binary-capable patch, lint evidence, and `implementation-review.md`.
5. `testing`: tester records validation and acceptance evidence. In apply mode, the tester and verification commands run in the same isolated worktree, then DevCrew refreshes the implementation diff and review before opening the testing gate.
6. `acceptance`: generated after the testing gate is approved.

`devcrew_start` runs the PM role for `requirements`. After the requester approves
a gate, `devcrew_continue` runs the role for the next phase before setting that
phase's gate to `pending`.

Plan mode advances directly from implementation-plan approval to testing. Apply mode uses this sequence:

```text
requirements approval
-> architecture approval
-> implementation plan approval
-> isolated execution
-> isolated testing
-> testing approval
-> patch promotion to requester repository
```

The implementation-plan approval advances the run to `execution`. One `devcrew_continue` call runs the implementer in the isolated worktree and leaves the run at `testing/ready`; another `devcrew_continue` runs the tester and verification commands before opening the testing gate.

Apply requires Git, a real Codex or Claude SDK backend, and a clean requester worktree both when execution starts and when the reviewed patch is promoted. The requester repository remains unchanged until testing approval. If testing is rejected, `devcrew_answer` records the response and returns the run to `execution/ready` with the isolated worktree intact.

`devcrew_start` records the created run as the active run for the repository.
Subsequent MCP calls can omit `runId`; DevCrew resolves it from
`.devcrew/active-run.json`. Plugin MCP configs set `DEVCREW_HOST`, so `host`
can also be omitted unless the caller needs an explicit override.

## Gates

Each main phase has a gate:

- `requirements`
- `architecture`
- `implementation`
- `testing`

The requester approves or rejects each gate. Rejection records feedback and returns the workflow to `awaiting_input`. In apply mode, rejecting testing never rolls changes back in the requester repository because no patch has been promoted yet.

## State And Artifacts

Runtime state is stored in:

```text
.devcrew/runs/<run-id>/state.json
```

The active run pointer is stored in:

```text
.devcrew/active-run.json
```

Reviewable artifacts are stored in:

```text
docs/devcrew/<run-id>/
```

The standard artifact set is:

- `requirements.md`
- `architecture.md`
- `implementation-plan.md`
- `implementation-review.md`
- `test-report.md`
- `acceptance.md`
