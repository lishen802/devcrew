---
name: devcrew
description: Run the DevCrew PM -> architecture -> implementation -> testing workflow. Use when the user asks for structured feature or product development across Codex or Claude Code.
---

Use the DevCrew MCP tools to manage the workflow:

1. Start with `devcrew_start` using the current repository cwd, host, mode, and request.
2. Use `devcrew_status` to show the current phase and pending gate.
3. Use `devcrew_answer` when the requester gives clarification.
4. Use `devcrew_approve` or `devcrew_reject` for each gate.
5. Use `devcrew_continue` after approvals to create the next phase artifact.
6. Use `devcrew_artifact` to read generated requirements, architecture, implementation-plan, test-report, or acceptance files.

Do not bypass host sandbox, approval, or tool permissions.
