---
name: devcrew
description: Run the DevCrew PM -> architecture -> implementation -> testing workflow. Use when the user asks for structured feature or product development, requirements clarification, architecture review, implementation planning, testing acceptance, or Chinese requests such as 完整研发流程, 需求澄清, 产品经理, 架构师, 开发测试流程.
---

Use the DevCrew MCP tools to manage the workflow:

1. Start with `devcrew_start` using the current repository cwd, mode, request, and optional executionMode. Host is inferred from the plugin's `DEVCREW_HOST`; pass host only for an explicit override. Omit executionMode unless the requester explicitly asks DevCrew to apply changes; the default safe mode is `plan`.
2. After start, DevCrew records the active run for this repository. For follow-up tools, omit runId unless you need to target a different run explicitly.
3. Use `executionMode: "apply"` only when the requester explicitly wants DevCrew to write code or run validation commands. This still inherits host sandbox, approval, and tool permissions.
4. Use `devcrew_status` to show the current phase and pending gate.
5. Use `devcrew_answer` when the requester gives clarification.
6. Use `devcrew_approve` or `devcrew_reject` for each gate.
7. Use `devcrew_continue` after approvals. This executes the next phase role, writes the phase artifact, and opens the next gate. The implementation phase also writes `implementation-review` for diff and architecture compliance review.
8. Use `devcrew_artifact` to read generated requirements, architecture, implementation-plan, implementation-review, test-report, or acceptance files.

Do not bypass host sandbox, approval, or tool permissions.
