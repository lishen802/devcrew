# Codex Setup

Run:

```bash
devcrew init /path/to/repo
```

The Codex plugin is generated at:

```text
plugins/devcrew-codex/
```

It contains:

- `.codex-plugin/plugin.json`
- `skills/devcrew/SKILL.md`
- `.mcp.json`
- role agent TOML templates under `agents/`

For local development, point a Codex marketplace entry at the generated plugin folder, or copy the plugin into your existing local marketplace workflow.

The DevCrew skill tells Codex to use these MCP tools:

- `devcrew_start`
- `devcrew_status`
- `devcrew_answer`
- `devcrew_approve`
- `devcrew_reject`
- `devcrew_continue`
- `devcrew_artifact`

Codex sandbox and approval settings remain authoritative. DevCrew does not bypass them.
