---
name: devcrew
description: Run the DevCrew PM -> architecture -> implementation -> testing workflow. Use when the user asks for structured feature or product development, requirements clarification, architecture review, implementation planning, testing acceptance, or Chinese requests such as 完整研发流程, 需求澄清, 产品经理, 架构师, 开发测试流程.
---

Use the DevCrew MCP tools to manage the workflow:

1. Start with `devcrew_start` using the current repository cwd, host, mode, request, and optional executionMode. Omit executionMode unless the requester explicitly asks DevCrew to apply changes; the default safe mode is `plan`.
2. Use `executionMode: "apply"` only when the requester explicitly wants DevCrew to write code or run validation commands. This still inherits host sandbox, approval, and tool permissions.
3. Use `devcrew_status` to show the current phase and pending gate.
4. Use `devcrew_answer` when the requester gives clarification.
5. Use `devcrew_approve` or `devcrew_reject` for each gate.
6. Use `devcrew_continue` after approvals. This executes the next phase role, writes the phase artifact, and opens the next gate.
7. Use `devcrew_artifact` to read generated requirements, architecture, implementation-plan, test-report, or acceptance files.

Do not bypass host sandbox, approval, or tool permissions.
