# Codex Setup

## Plugin marketplace install

Add the DevCrew marketplace:

```bash
codex plugin marketplace add lishen802/devcrew
```

Restart Codex, open the plugin directory, select the DevCrew marketplace, and install the DevCrew plugin.

The plugin launches the MCP server with:

```bash
npx -y devcrew@0.1.0 serve --stdio
```

Use this path when you want to use DevCrew without cloning the repository first. The version is locked to the published npm package that matches the plugin manifest.

## Local development install

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
