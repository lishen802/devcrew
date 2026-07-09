# Quickstart

## 1. Install

From npm:

```bash
npm install -g @shenlee/devcrew
```

For local development:

```bash
npm install
npm run validate
npm link
```

## 2. Initialize A Repository

```bash
devcrew init /path/to/repo
```

This creates:

- `.devcrew/config.json`
- `.devcrew/standards.md`
- `docs/devcrew/`
- `plugins/devcrew-codex/`
- `plugins/devcrew-claude/`

## 3. Start The MCP Service

```bash
devcrew serve --stdio
```

Normally the generated plugin starts this command for the host agent.
Codex and Claude plugin bundles use `npx -y @shenlee/devcrew@0.1.0 serve --stdio` so the MCP service is locked to the published package version.

## 4. Run A Workflow

Ask the host agent:

```text
Use DevCrew for this request: add release notes generation to this repository.
```

Expected flow:

1. Agent calls `devcrew_start`.
2. Agent reads `requirements.md`.
3. You approve or reject requirements.
4. Agent calls `devcrew_continue`.
5. Repeat for architecture, implementation plan, and test report.

## 5. Review Artifacts

Artifacts are written under:

```text
docs/devcrew/<run-id>/
```
