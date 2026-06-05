# DevCrew

[English](README.md) | 简体中文

DevCrew 是一个面向 Codex、Claude Code 等编程 Agent 的本地工作流服务。它把一次功能或产品开发拆成带门禁的专业流程：

需求提出者 -> 产品经理 -> 架构师 -> 实现工程师 -> 测试验收 -> 交付确认。

项目目标是让 Agent 不只是“直接写代码”，而是像一个小型开发团队一样，先澄清需求、确认边界，再设计方案、实施、测试并产出可审查的文档。

## 核心能力

- 内置阶段门禁：需求确认、架构确认、实现计划确认、测试报告确认。
- 支持两种工作流：`feature` 用于已有项目功能开发，`greenfield` 用于从零开始的新产品。
- 支持安全执行模式：默认是 `plan`，只有显式请求 `apply` 时，implementer/tester 阶段才允许写文件或运行验证命令。
- 默认按当前宿主选择后端：在 Codex 中优先使用 Codex，在 Claude Code 中优先使用 Claude。
- 已接入角色编排：`devcrew_start` 会先运行 PM 角色，`devcrew_continue` 会运行下一阶段角色，然后再打开阶段门禁。
- 实现评审产物：implementation gate 会附带 changed files、捕获的 diff 和架构符合性审查说明。
- 运行状态写入 `.devcrew/runs/<run-id>/state.json`，评审产物写入 `docs/devcrew/<run-id>/`。
- 自动发现项目规范：`.devcrew/standards.md`、`AGENTS.md`、`CLAUDE.md`、README 以及常见项目配置文件。
- 提供 MCP 工具：`devcrew_start`、`devcrew_status`、`devcrew_answer`、`devcrew_approve`、`devcrew_reject`、`devcrew_continue`、`devcrew_artifact`。
- 可通过 `devcrew init` 生成 Codex 和 Claude Code 插件骨架。

## 作为 Codex 插件安装

添加 DevCrew marketplace：

```bash
codex plugin marketplace add lishen802/devcrew
```

重启 Codex，打开插件目录，选择 DevCrew marketplace，然后安装 DevCrew 插件。

插件会用下面的命令启动 DevCrew MCP 服务：

```bash
npx -y github:lishen802/devcrew serve --stdio
```

也就是说，只是使用插件时不需要先克隆源码；你只需要本机有 Node.js，并且 Codex 第一次启动 MCP 服务时可以访问网络。

## 从源码安装

```bash
npm install
npm run validate
npm link
```

初始化一个项目：

```bash
devcrew init /path/to/repo
devcrew doctor /path/to/repo
```

初始化后会生成：

- `.devcrew/config.json`
- `.devcrew/standards.md`
- `docs/devcrew/`
- `plugins/devcrew-codex/`
- `plugins/devcrew-claude/`

## 在 Agent 中使用

通过生成的插件配置启动 MCP 服务：

```bash
devcrew serve --stdio
```

然后在 Codex 或 Claude Code 中调用 DevCrew，例如：

```text
使用 DevCrew 帮我规划并实现 billing API 的审计日志功能。
```

典型流程：

1. Agent 调用 `devcrew_start` 创建工作流。
2. DevCrew 运行 PM 角色生成需求文档并等待你确认。
3. 你通过 `devcrew_approve` 或 `devcrew_reject` 推进或驳回阶段。
4. 需求确认后，`devcrew_continue` 会运行架构师角色，再依次进入实现计划和测试验收。
5. 所有产物都会保存在 `docs/devcrew/<run-id>/`，方便审查和版本管理。

默认情况下 DevCrew 使用安全的 `plan` 模式。如果你希望 implementer/tester 阶段真正修改仓库并运行配置好的验证命令，需要明确要求 apply 模式：

```text
使用 DevCrew apply 模式帮我实现 billing API 的审计日志功能。
```

DevCrew 会自动从常见项目清单中发现验证命令。当前规则会优先读取 `package.json` scripts（`validate`，然后是 `test`，再到 `typecheck`/`lint`），再按项目清单回退到 `go test ./...`、`cargo test` 或 `python -m pytest`。

你也可以在 `.devcrew/config.json` 中显式覆盖：

```json
{
  "version": 1,
  "defaultBackend": "host-preferred",
  "executionMode": "plan",
  "verifyCommands": ["npm run validate"],
  "workflow": {
    "gates": ["requirements", "architecture", "implementation", "testing"],
    "artifactDirectory": "docs/devcrew"
  }
}
```

## 开发命令

```bash
npm test
npm run build
npm run validate
```

当前适配器在未安装 Codex SDK 或 Claude SDK 时会使用确定性的本地 fallback 输出。这样可以保证测试和演示稳定，同时保留接入真实宿主 SDK 的边界。即使在 `apply` 模式下，DevCrew 仍然继承宿主的 sandbox、审批和工具权限。

## 文档

- [快速开始](docs/quickstart.md)
- [Codex 接入](docs/codex.md)
- [Claude Code 接入](docs/claude-code.md)
- [工作流模型](docs/workflow.md)
- [角色定制](docs/roles.md)
- [示例](examples/README.md)

## 许可证

Apache-2.0
