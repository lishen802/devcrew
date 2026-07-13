# Claude Code Setup

Run:

```bash
devcrew init /path/to/repo
devcrew doctor /path/to/repo
```

The Claude Code plugin is generated at:

```text
plugins/devcrew-claude/
```

It contains:

- `.claude-plugin/plugin.json`
- `skills/devcrew/SKILL.md`
- `.mcp.json`

Role behavior is defined by the DevCrew MCP service and its shared runtime role
schema. The plugin intentionally does not bundle inactive subagent templates.

For local plugin testing:

```bash
claude --plugin-dir plugins/devcrew-claude
```

Then ask Claude Code to use DevCrew for a feature or product workflow. The generated `.mcp.json` starts the version-locked npm package with an `npm exec --package=@shenlee/devcrew@0.1.3` wrapper.

The default apply policy is `interactive-host`: Claude Code performs implementation and testing with its native controls. Explicit `headless-restricted` and `headless-unattended` policies are independent DevCrew SDK policies and do not inherit the current Claude Code approval session.

For apply mode, `@anthropic-ai/claude-agent-sdk` must be resolvable from the installed DevCrew package. Published DevCrew packages declare it as an optional dependency, which npm installs by default. If `devcrew doctor` reports it as missing, reinstall DevCrew with optional dependencies enabled:

```bash
npm install -g @shenlee/devcrew --include=optional
```
