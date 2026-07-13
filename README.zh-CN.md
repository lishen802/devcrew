# DevCrew

[English](README.md) | 简体中文

DevCrew 是一个面向 Codex、Claude Code 等编程 Agent 的本地工作流服务。它把一次功能或产品开发拆成带门禁的专业流程：

需求提出者 -> 产品经理 -> 架构师 -> 实现工程师 -> 测试验收 -> 交付确认。

项目目标是让 Agent 不只是“直接写代码”，而是像一个小型开发团队一样，先澄清需求、确认边界，再设计方案、实施、测试并产出可审查的文档。

## 核心能力

- 内置阶段门禁：需求确认、架构确认、实现计划确认、测试报告确认。
- 支持两种工作流：`feature` 用于已有项目功能开发，`greenfield` 用于从零开始的新产品。
- 支持安全执行模式：默认是 `plan`，`apply` 必须显式开启。apply 默认使用 `interactive-host`，在 DevCrew 管理的 Git worktree 中暂停并交给宿主原生 agent 执行；headless 策略使用单独声明的 SDK 权限。
- 默认按当前宿主选择后端：在 Codex 中优先使用 Codex，在 Claude Code 中优先使用 Claude。
- 已接入角色编排：`devcrew_start` 会先运行 PM 角色，`devcrew_continue` 会运行下一阶段角色，然后再打开阶段门禁。
- 实现评审产物：隔离执行会记录 changed files、支持二进制的 diff、lint 证据和架构符合性说明；测试结束后会重新生成评审 diff，再等待晋升。
- 架构复审结果结构化：执行后架构师必须给出 `approved` 或 `changes_required`；需要修改时会阻断 testing。
- 运行状态写入 `.devcrew/runs/<run-id>/state.json`，评审产物写入 `docs/devcrew/<run-id>/`。
- 自动发现项目规范：`.devcrew/standards.md`、`AGENTS.md`、`CLAUDE.md`、README 以及常见项目配置文件。
- 提供 MCP 工具：`devcrew_start`、`devcrew_status`、`devcrew_answer`、`devcrew_approve`、`devcrew_reject`、`devcrew_continue`、`devcrew_complete_execution`、`devcrew_waive_verification`、`devcrew_artifact`。
- 可通过 `devcrew init` 生成 Codex 和 Claude Code 插件骨架。

## 作为 Codex 插件安装

添加 DevCrew marketplace：

```bash
codex plugin marketplace add lishen802/devcrew
```

重启 Codex，打开插件目录，选择 DevCrew marketplace，然后安装 DevCrew 插件。

插件会用下面的命令启动 DevCrew MCP 服务：

```bash
npm exec --silent --yes --package=@shenlee/devcrew@0.1.2 -- node -e "<DevCrew CLI wrapper>" -- serve --stdio
```

插件会锁定到已发布的 npm 包版本，因此用户不需要克隆源码，也不需要在安装时编译 TypeScript；只需要本机有 Node.js，并且 Codex 第一次启动 MCP 服务时可以访问网络。

## 通过 npm 安装

```bash
npm install -g @shenlee/devcrew
devcrew doctor /path/to/repo
```

npm 包发布名是 `@shenlee/devcrew`，安装后的 CLI 命令仍然是 `devcrew`。它会把 Codex SDK 和 Claude Agent SDK 声明为 optional dependencies。npm 默认会安装 optional dependencies；如果你的环境跳过了它们，可以用 `npm install -g @shenlee/devcrew --include=optional` 重新安装。`devcrew doctor` 会检查 `@openai/codex-sdk` 和 `@anthropic-ai/claude-agent-sdk` 是否可解析，用于确认真实宿主后端的 `apply` 流程是否可用。

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

插件会设置 `DEVCREW_HOST` 用于宿主识别，因此 `devcrew_start` 可以省略 `host`，除非你需要显式覆盖。DevCrew 会把最新 run 记录为当前仓库的 active run，后续 MCP 调用可以省略 `runId`。

默认情况下 DevCrew 使用安全的 `plan` 模式。如果你希望隔离执行阶段真正修改文件，并在隔离测试阶段运行配置好的验证命令，需要明确要求 apply 模式：

```text
使用 DevCrew apply 模式帮我实现 billing API 的审计日志功能。
```

apply 模式的固定顺序是：

```text
需求确认
-> 架构确认
-> 实现计划确认
-> 隔离执行
-> 架构审查确认
-> 隔离测试
-> 测试报告确认
-> 将补丁晋升到需求方仓库
```

apply 模式要求项目是 Git 仓库，并且在开始隔离执行和最终晋升补丁时，需求方工作树都必须保持干净。默认的 `interactive-host` 不会启动嵌套 SDK：每次 `devcrew_continue` 后会在 `awaiting_execution` 等待宿主原生 agent 在指定隔离 worktree 中工作；实现完成后调用 `devcrew_complete_execution`，测试完成时还要提交命令、退出码和输出证据。显式的 `headless-restricted` 与 `headless-unattended` 才使用 DevCrew 管理的 SDK 权限，它们不会继承当前宿主的审批会话。测试门禁批准前，需求方仓库不会出现实现改动；验证失败会进入 `awaiting_input`，只有通过 `devcrew_waive_verification` 记录明确风险原因后才可重新打开审批。驳回测试并提交反馈答案会回到同一个隔离工作树的 `execution` 阶段，不会修改需求方仓库。

DevCrew 会自动从常见项目清单中发现验证命令。当前规则会优先读取 `package.json` scripts（`validate`，然后是 `test`，再到 `typecheck`/`lint`），再按项目清单回退到 `go test ./...`、`cargo test` 或 `python -m pytest`。

你也可以在 `.devcrew/config.json` 中显式覆盖：

```json
{
  "version": 1,
  "defaultBackend": "host-preferred",
  "executionMode": "plan",
  "verifyCommands": ["npm run validate"],
  "workflow": {
    "gates": ["requirements", "architecture", "implementation", "implementation-review", "testing"],
    "artifactDirectory": "docs/devcrew"
  }
}
```

`workflow.gates` 只控制是否需要人工审批 `requirements`、`architecture` 和
`implementation` 产物。省略其中任意项仍会执行相应角色并写入产物，只是不再停下来等待审批，而是自动进入下一阶段。`implementation-review` 与 `testing` 是强制安全门禁：即使配置中省略，也始终启用。

## 开发命令

```bash
npm test
npm run build
npm run validate
npm pack --dry-run
```

当前适配器在未安装 Codex SDK 或 Claude SDK 时会使用确定性的本地 fallback 输出。这样可以保证测试和演示稳定，同时保留接入真实宿主 SDK 的边界。嵌套 SDK 的 apply 运行使用记录在状态中的 DevCrew headless 策略，不会继承当前宿主的 sandbox、审批或工具会话。

对于发布安装，宿主 SDK 包会作为精确锁定的 optional dependencies 随 DevCrew 一起安装，因此锁定版本的 `npm exec --package=@shenlee/devcrew@<version>` wrapper 可以从 DevCrew 包自身解析这些 SDK。plan 模式仍允许 deterministic fallback；但 apply 模式在选定宿主 SDK 不可用时会直接失败，并给出明确的 SDK 解析错误。

公开 npm 发布由 `npm publish` GitHub Actions 工作流处理。发布 GitHub Release 或手动触发 workflow 时，它会先运行验证，再执行 `npm pack --dry-run` 检查包内容，最后在配置 `NPM_TOKEN` 后使用 npm provenance 发布公开包。

发布插件锁定的 npm 版本后，再运行真实 marketplace smoke test。由于插件锁定了 npm 版本，这是发布后的检查：

```bash
npm run smoke:codex-plugin
```

它会在隔离的 `CODEX_HOME` 中从 Codex marketplace 安装 DevCrew，启动安装后的 MCP 服务，并跑完整的 plan 模式工作流。

## 文档

- [快速开始](docs/quickstart.md)
- [Codex 接入](docs/codex.md)
- [Claude Code 接入](docs/claude-code.md)
- [工作流模型](docs/workflow.md)
- [角色定制](docs/roles.md)
- [示例](examples/README.md)

## 许可证

Apache-2.0
