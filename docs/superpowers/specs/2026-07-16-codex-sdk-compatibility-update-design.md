# Codex SDK Compatibility Update Design

## Context

DevCrew 0.1.4 pins `@openai/codex-sdk` to 0.137.0. The SDK wraps its own matching Codex runtime, but DevCrew does not pass an explicit model when it starts a planning thread. The nested runtime therefore loads the normal Codex configuration layers. When the user-level model is newer than that runtime supports, the role call fails and plan mode falls back to the deterministic template.

The observed failure used `gpt-5.6-sol`: the host Codex session was able to use the model, while the DevCrew-bundled 0.137.0 runtime returned an HTTP 400 requiring a newer Codex version.

## Goals

- Restore Codex-backed DevCrew role generation for the currently configured model.
- Keep published installs reproducible by continuing to pin an exact SDK version.
- Preserve host model selection and the existing sandbox, approval, and fallback behavior.
- Verify the dependency contract, TypeScript adapter contract, tests, and package contents.

## Non-goals

- Add a DevCrew-specific model setting.
- Replace the SDK-bundled runtime with whichever `codex` executable happens to be on `PATH`.
- Change plan-mode fallback semantics or MCP response schemas.
- Change Claude Agent SDK dependencies.

## Options Considered

### 1. Upgrade the pinned Codex SDK and bundled runtime

Pin `@openai/codex-sdk` to the current stable 0.144.5 release. Its declared dependency pins `@openai/codex` to the same version and remains compatible with DevCrew's Node.js requirement.

This is the selected option because it restores compatibility while preserving deterministic package resolution and the existing adapter boundary.

### 2. Add a DevCrew-specific model override

This would let DevCrew choose a model known to work with its bundled runtime, but it would expand the configuration schema and could unexpectedly diverge from the user's selected Codex model. It also turns a stale runtime into a recurring configuration burden.

### 3. Force the SDK to use the system Codex executable

Passing a `codexPathOverride` could reuse the newer host CLI, but published behavior would then depend on an executable outside the DevCrew package. That weakens reproducibility and makes plugin diagnosis harder across Codex surfaces.

## Design

Update the exact optional dependency in `package.json` from 0.137.0 to 0.144.5 and regenerate `package-lock.json` with npm. Update the package metadata test that intentionally guards the pinned host SDK versions.

No adapter code changes are expected. DevCrew will continue to instantiate `Codex` without a path override, so the SDK resolves its matching packaged runtime. DevCrew will also continue to omit `model` from thread options, allowing normal Codex configuration precedence to select the model.

The existing error path remains intact: if a future SDK call fails in plan mode, DevCrew records `usedFallback`, writes the SDK fallback notice with the original reason, and exposes `role_fallback=sdk` through the MCP result. Apply mode continues to fail instead of silently accepting a fallback.

## Testing

1. Update the existing package metadata assertion first so it fails against 0.137.0.
2. Regenerate the lockfile and verify the resolved SDK, Codex package, and platform runtime are all 0.144.5.
3. Run the adapter SDK tests to confirm the pinned thread options still match the current SDK contract.
4. Run the full `npm run validate` suite.
5. Run `npm pack --dry-run` to verify the published artifact still contains the required package files.

A live model call is not part of the deterministic test suite because it depends on account entitlements, network access, and the user's active model configuration. The resolved bundled runtime version is the local compatibility evidence; a plugin smoke run can be performed separately when release credentials and network are available.

## Acceptance Criteria

- `package.json` and `package-lock.json` pin `@openai/codex-sdk` to 0.144.5.
- The installed `@openai/codex-sdk`, `@openai/codex`, and native Codex runtime resolve to 0.144.5.
- Existing Codex adapter behavior and fallback behavior remain unchanged.
- `npm run validate` passes.
- `npm pack --dry-run` succeeds.
