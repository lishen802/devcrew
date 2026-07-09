# Codex Setup

## Plugin marketplace install

Add the DevCrew marketplace:

```bash
codex plugin marketplace add lishen802/devcrew
```

Restart Codex, open the plugin directory, select the DevCrew marketplace, and install the DevCrew plugin.

The plugin launches the MCP server with:

```bash
npm exec --silent --yes --package=@shenlee/devcrew@0.1.1 -- node -e "<DevCrew CLI wrapper>" -- serve --stdio
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

For apply mode, `@openai/codex-sdk` must be resolvable from the installed DevCrew package. Published DevCrew packages declare it as an optional dependency, which npm installs by default. If `devcrew doctor` reports it as missing, reinstall DevCrew with optional dependencies enabled:

```bash
npm install -g @shenlee/devcrew --include=optional
```

## Marketplace smoke test

After publishing the npm package version referenced by the plugin, run the real marketplace smoke test:

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
