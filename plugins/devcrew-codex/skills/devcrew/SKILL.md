---
name: devcrew
description: Run the DevCrew PM -> architecture -> implementation -> testing workflow. Use when the user asks for structured feature or product development, requirements clarification, architecture review, implementation planning, testing acceptance, or Chinese requests such as 完整研发流程, 需求澄清, 产品经理, 架构师, 开发测试流程.
---

Use the DevCrew MCP tools to manage the workflow:

1. Start with `devcrew_start` using the current repository cwd, mode, request, and optional `executionMode`. Host is inferred from the plugin's `DEVCREW_HOST`; pass host only for an explicit override. Omit `executionMode` unless the requester explicitly asks DevCrew to apply changes; the default safe mode is `plan`.
2. After start, DevCrew records the active run for this repository. For follow-up tools, omit `runId` unless you need to target a different run explicitly.
3. For `executionMode: "apply"`, choose an explicit `executionPolicy`. The default `interactive-host` pauses at implementation and testing for the host's native agent to work in DevCrew's isolated worktree. `headless-restricted` and `headless-unattended` are DevCrew SDK policies; they do not inherit the current host approval session.
4. Use `devcrew_status` to show the current phase, pending gate, and any execution instruction.
5. Use `devcrew_answer` when the requester gives clarification.
6. Use `devcrew_approve` or `devcrew_reject` for each gate.
7. Use `devcrew_continue` after approvals. Apply runs enter an `implementation-review` gate after execution: review the architect's `architecture-review` artifact before testing. For `interactive-host`, if status becomes `awaiting_execution`, perform the native-host work in the indicated worktree then call `devcrew_complete_execution`. For testing, include command, exit code, output, startedAt, and completedAt evidence.
8. Failed verification is not approvable. Revise through `devcrew_answer`, or use `devcrew_waive_verification` only when the requester explicitly accepts the recorded risk and provides a reason.
9. Use `devcrew_artifact` to read generated requirements, architecture, implementation-plan, implementation-review, architecture-review, test-report, or acceptance files.

Never describe a nested SDK session as inheriting the current host's approval decisions.
