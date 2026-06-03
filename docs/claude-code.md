# Claude Code Setup

Run:

```bash
devcrew init /path/to/repo
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

Then ask Claude Code to use DevCrew for a feature or product workflow. The generated `.mcp.json` starts `devcrew serve --stdio`.

Claude Code permissions, hooks, and approval settings remain authoritative. DevCrew inherits the host boundary.
