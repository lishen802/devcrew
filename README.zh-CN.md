# DevCrew

[English](README.md) | 简体中文

DevCrew 是一个面向 Codex、Claude Code 等编程 Agent 的本地工作流服务。它把一次功能或产品开发拆成带门禁的专业流程：

需求提出者 -> 产品经理 -> 架构师 -> 实现工程师 -> 测试验收 -> 交付确认。

项目目标是让 Agent 不只是“直接写代码”，而是像一个小型开发团队一样，先澄清需求、确认边界，再设计方案、实施、测试并产出可审查的文档。

## 核心能力

- 内置阶段门禁：需求确认、架构确认、实现计划确认、测试报告确认。
- 支持两种工作流：`feature` 用于已有项目功能开发，`greenfield` 用于从零开始的新产品。
- 默认按当前宿主选择后端：在 Codex 中优先使用 Codex，在 Claude Code 中优先使用 Claude。
- 运行状态写入 `.devcrew/runs/<run-id>/state.json`，评审产物写入 `docs/devcrew/<run-id>/`。
- 自动发现项目规范：`.devcrew/standards.md`、`AGENTS.md`、`CLAUDE.md`、README 以及常见项目配置文件。
- 提供 MCP 工具：`devcrew_start`、`devcrew_status`、`devcrew_answer`、`devcrew_approve`、`devcrew_reject`、`devcrew_continue`、`devcrew_artifact`。
- 可通过 `devcrew init` 生成 Codex 和 Claude Code 插件骨架。

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
2. DevCrew 生成需求文档并等待你确认。
3. 你通过 `devcrew_approve` 或 `devcrew_reject` 推进或驳回阶段。
4. 需求确认后进入架构设计，再进入实现计划和测试验收。
5. 所有产物都会保存在 `docs/devcrew/<run-id>/`，方便审查和版本管理。

## 开发命令

```bash
npm test
npm run build
npm run validate
```

当前适配器在未安装 Codex SDK 或 Claude SDK 时会使用确定性的本地 fallback 输出。这样可以保证测试和演示稳定，同时保留后续接入真实宿主 SDK 的边界。

## 文档

- [快速开始](docs/quickstart.md)
- [Codex 接入](docs/codex.md)
- [Claude Code 接入](docs/claude-code.md)
- [工作流模型](docs/workflow.md)
- [角色定制](docs/roles.md)
- [示例](examples/README.md)

## 许可证

Apache-2.0
