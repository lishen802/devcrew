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
3. `implementation`: implementer creates the implementation plan and coding checklist.
4. `testing`: tester records validation strategy and acceptance evidence.
5. `acceptance`: generated after the testing gate is approved.

`devcrew_start` runs the PM role for `requirements`. After the requester approves
a gate, `devcrew_continue` runs the role for the next phase before setting that
phase's gate to `pending`.

## Gates

Each main phase has a gate:

- `requirements`
- `architecture`
- `implementation`
- `testing`

The requester approves or rejects each gate. Rejection records feedback and returns the workflow to `awaiting_input`.

## State And Artifacts

Runtime state is stored in:

```text
.devcrew/runs/<run-id>/state.json
```

Reviewable artifacts are stored in:

```text
docs/devcrew/<run-id>/
```
