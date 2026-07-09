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
- `agents/*.md`
- `.mcp.json`

For local plugin testing:

```bash
claude --plugin-dir plugins/devcrew-claude
```

Then ask Claude Code to use DevCrew for a feature or product workflow. The generated `.mcp.json` starts the version-locked npm package with an `npm exec --package=@shenlee/devcrew@0.1.1` wrapper.

Claude Code permissions, hooks, and approval settings remain authoritative. DevCrew inherits the host boundary.

For apply mode, `@anthropic-ai/claude-agent-sdk` must be resolvable from the installed DevCrew package. Published DevCrew packages declare it as an optional dependency, which npm installs by default. If `devcrew doctor` reports it as missing, reinstall DevCrew with optional dependencies enabled:

```bash
npm install -g @shenlee/devcrew --include=optional
```
