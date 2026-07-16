# Codex Setup

## Plugin marketplace install

Add the DevCrew marketplace:

```bash
codex plugin marketplace add lishen802/devcrew
```

Restart Codex, open the plugin directory, select the DevCrew marketplace, and install the DevCrew plugin.

The plugin launches the MCP server with:

```bash
npm exec --silent --yes --package=@shenlee/devcrew@0.1.5 -- node -e "<DevCrew CLI wrapper>" -- serve --stdio
```

Use this path when you want to use DevCrew without cloning the repository first. The version is locked to the published npm package that matches the plugin manifest.

## Local development install

Run:

```bash
devcrew init /path/to/repo
devcrew doctor /path/to/repo
```

The Codex plugin is generated at:

```text
plugins/devcrew-codex/
```

It contains:

- `.codex-plugin/plugin.json`
- `skills/devcrew/SKILL.md`
- `.mcp.json`

Role behavior is defined by the DevCrew MCP service and its shared runtime role
schema. The plugin intentionally does not bundle inactive subagent templates.

## Structured role results

SDK roles should return one `<!-- devcrew-role-result -->` marker followed by a
JSON fenced block with `schemaVersion: 1`, then the human-readable Markdown
artifact. The JSON carries the role summary, risks, command evidence, and
role-specific fields such as PM questions, architecture decisions, changed
files, or test cases. DevCrew removes the marked block before saving the
Markdown artifact and exposes the validated data through MCP state.

Markdown-only output remains supported as `role_format=legacy`. A missing marker
uses this compatibility path; a present marker with malformed, ambiguous, or
schema-invalid JSON is rejected and never silently downgraded.

For local development, point a Codex marketplace entry at the generated plugin folder, or copy the plugin into your existing local marketplace workflow.

The DevCrew skill tells Codex to use these MCP tools:

- `devcrew_start`
- `devcrew_status`
- `devcrew_answer`
- `devcrew_approve`
- `devcrew_reject`
- `devcrew_continue`
- `devcrew_complete_execution`
- `devcrew_waive_verification`
- `devcrew_artifact`

The default apply policy is `interactive-host`: Codex performs the implementation and testing with its native controls. A DevCrew nested SDK is not used in this path. Explicit `headless-restricted` and `headless-unattended` policies are separate DevCrew policies and do not inherit the current Codex approval session.

Apply mode keeps implementation planning read-only. With `interactive-host`, after the implementation gate is approved, call `devcrew_continue`; DevCrew creates `.devcrew/worktrees/<run-id>` and waits at `awaiting_execution`. Use Codex natively in that worktree, then call `devcrew_complete_execution`. Repeat for testing and include command, exit-code, and output evidence. A failed verification cannot open the testing gate; revise it or record an explicit reason through `devcrew_waive_verification`. Testing approval promotes the exact reviewed patch to the requester repository.

Apply mode requires a Git repository, a clean requester worktree at execution and promotion, and a real Codex SDK backend.

For apply mode, `@openai/codex-sdk` must be resolvable from the installed DevCrew package. Published DevCrew packages declare it as an optional dependency, which npm installs by default. If `devcrew doctor` reports it as missing, reinstall DevCrew with optional dependencies enabled:

```bash
npm install -g @shenlee/devcrew --include=optional
```

## Marketplace smoke test

After publishing `@shenlee/devcrew@0.1.5`, run the real marketplace smoke test. Do not treat this as a pre-publication check because the plugin is locked to that npm version:

```bash
npm run smoke:codex-plugin
```

The smoke test creates an isolated `CODEX_HOME`, adds the `lishen802/devcrew` marketplace, installs `devcrew@devcrew`, starts the installed plugin's MCP server from `.mcp.json`, and runs a complete plan-mode workflow through JSON-RPC.

Useful options:

```bash
node scripts/smoke-codex-plugin.mjs --keep-temp
node scripts/smoke-codex-plugin.mjs --source lishen802/devcrew --ref main
```

The default path is intentionally production-like: it uses the GitHub marketplace and the version-locked npm package from the installed plugin. It requires network access, Codex CLI, Node.js, and a published `@shenlee/devcrew` npm version matching the plugin manifest.
