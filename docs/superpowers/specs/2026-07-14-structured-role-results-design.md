# Structured Role Results Design

## Objective

Make DevCrew role output machine-readable without breaking existing Markdown-only
SDK output or the human-readable artifact workflow. A structured result becomes
the canonical source for workflow decisions and evidence when it is present;
Markdown remains the reviewable artifact body and the compatibility fallback.

## Scope

This change covers the PM, architect, implementer, and tester role results used
by the SDK adapters and orchestrator. It does not remove Markdown artifacts,
change MCP tool names, change execution policies, or require existing installed
plugins to update simultaneously.

## Result Envelope

The core package will define a versioned role-result envelope with common fields:

- `schemaVersion: 1`
- `role`
- `summary`
- `markdown`
- `risks`
- `evidence`

Role-specific fields are validated by role:

- PM: `questions`, where each question has a stable `id`, prompt, and optional
  context.
- Architect: `decisions`; during the post-execution review phase,
  `reviewDecision` is `approved` or `changes_required`.
- Implementer: `changedFiles` and `commands`, including command, exit code, and
  captured output.
- Tester: `testCases`, `commands`, and `risks`.

The canonical TypeScript representation stores a `format` discriminator:
`structured` for a validated envelope and `legacy` for a Markdown-only result.
This allows callers and MCP clients to identify migration state without parsing
text.

## Adapter Parsing And Compatibility

SDK prompts will request one fenced `json` block labelled as the DevCrew result,
followed by the existing required Markdown H2 sections. The adapter extracts and
validates that JSON before accepting a structured result.

If a JSON block is absent, the adapter preserves existing Markdown validation and
the current PM-question and architecture-review decision parsing. It returns a
`legacy` result and no new structured fields are inferred from arbitrary prose.

If a DevCrew JSON block is present but malformed, has an unsupported schema
version, does not match the active role, or fails field validation, the adapter
rejects the SDK output. It must not silently downgrade malformed claimed
structured output to legacy Markdown. Existing plan-mode fallback and apply-mode
failure rules remain unchanged.

## Workflow And Artifact Behaviour

The orchestrator consumes validated structured fields when available. PM
questions continue to route the run to `awaiting_input`; legacy Markdown
questions retain the current behavior. Architecture review decisions retain
their blocking semantics. Implementer and tester evidence is persisted in the
role result, surfaced by MCP state, and rendered into the corresponding Markdown
artifact as a readable structured-results appendix.

The role result stored in run state must remain loadable when older saved states
lack the new fields. Missing fields migrate to `format: legacy` and empty
optional arrays. No saved state becomes invalid merely because it predates this
feature.

## Error Handling

- No JSON envelope: accept the valid legacy Markdown result.
- Multiple candidate envelopes: reject as ambiguous.
- Invalid envelope: report field-specific validation errors.
- Envelope role/phase mismatch: reject before state or artifact writes.
- Structured PM questions: require nonempty unique IDs and nonempty prompts.
- Command evidence: require a command and integer exit code; output is optional.

## Testing

Tests will be written before production code and prove:

1. A valid envelope parses and exposes each role's structured fields.
2. Missing envelope preserves legacy Markdown behavior.
3. Malformed, ambiguous, version-invalid, and role-invalid envelopes fail rather
   than downgrade.
4. Structured PM questions enter `awaiting_input`.
5. Structured architecture review decisions gate testing correctly.
6. Implementer and tester evidence persists and is visible in generated
   artifacts and structured MCP state.
7. Loading a prior state without the new fields migrates safely.
