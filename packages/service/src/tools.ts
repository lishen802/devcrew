import {
  getArtifact,
  getActiveRunId,
  getWorkflowStatus,
  setActiveRun,
  type Host,
  type RunState,
} from "../../core/src/index.js";
import {
  answerOrchestratedWorkflow,
  approveOrchestratedWorkflow,
  continueOrchestratedWorkflow,
  rejectOrchestratedWorkflow,
  startOrchestratedWorkflow,
} from "../../orchestrator/src/index.js";

export interface DevCrewTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const cwdProperty = { type: "string", description: "Repository working directory." };
const runIdProperty = { type: "string", description: "DevCrew run id." };
const hostValues = ["codex", "claude"] as const;

function inferHost(env: NodeJS.ProcessEnv = process.env): Host {
  const host = env.DEVCREW_HOST;
  return host === "claude" || host === "codex" ? host : "codex";
}

async function withActiveRun(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof args.runId === "string" && args.runId.trim()) {
    return args;
  }
  if (typeof args.cwd !== "string" || !args.cwd.trim()) {
    return args;
  }
  return { ...args, runId: await getActiveRunId(args.cwd) };
}

function withInferredHost(args: Record<string, unknown>): Record<string, unknown> {
  if (typeof args.host === "string" && hostValues.includes(args.host as Host)) {
    return args;
  }
  return { ...args, host: inferHost() };
}

export function listDevCrewTools(): DevCrewTool[] {
  return [
    {
      name: "devcrew_start",
      description: "Create a new gated DevCrew workflow run.",
      inputSchema: {
        type: "object",
        required: ["cwd", "mode", "request"],
        properties: {
          cwd: cwdProperty,
          host: { type: "string", enum: ["codex", "claude"], description: "Optional host override. Defaults to DEVCREW_HOST or codex." },
          mode: { type: "string", enum: ["feature", "greenfield"] },
          executionMode: {
            type: "string",
            enum: ["plan", "apply"],
            description: "Execution mode. Defaults to plan; apply must be explicit.",
          },
          request: { type: "string" },
          backend: { type: "string", enum: ["codex", "claude", "local"] },
        },
      },
    },
    {
      name: "devcrew_status",
      description: "Read the status of a DevCrew workflow run.",
      inputSchema: {
        type: "object",
        required: ["cwd"],
        properties: { cwd: cwdProperty, runId: runIdProperty },
      },
    },
    {
      name: "devcrew_answer",
      description: "Record requester clarification input for the current gate.",
      inputSchema: {
        type: "object",
        required: ["cwd", "answer"],
        properties: { cwd: cwdProperty, runId: runIdProperty, answer: { type: "string" } },
      },
    },
    {
      name: "devcrew_approve",
      description: "Approve the current workflow gate and advance to the next phase.",
      inputSchema: {
        type: "object",
        required: ["cwd", "gate"],
        properties: {
          cwd: cwdProperty,
          runId: runIdProperty,
          gate: { type: "string", enum: ["requirements", "architecture", "implementation", "testing"] },
          note: { type: "string" },
        },
      },
    },
    {
      name: "devcrew_reject",
      description: "Reject the current workflow gate and record feedback.",
      inputSchema: {
        type: "object",
        required: ["cwd", "gate", "feedback"],
        properties: {
          cwd: cwdProperty,
          runId: runIdProperty,
          gate: { type: "string", enum: ["requirements", "architecture", "implementation", "testing"] },
          feedback: { type: "string" },
        },
      },
    },
    {
      name: "devcrew_continue",
      description: "Continue a run after the previous gate was approved.",
      inputSchema: {
        type: "object",
        required: ["cwd"],
        properties: { cwd: cwdProperty, runId: runIdProperty },
      },
    },
    {
      name: "devcrew_artifact",
      description: "Read a generated workflow artifact.",
      inputSchema: {
        type: "object",
        required: ["cwd", "name"],
        properties: {
          cwd: cwdProperty,
          runId: runIdProperty,
          name: {
            type: "string",
            enum: ["requirements", "architecture", "implementation-plan", "implementation-review", "test-report", "acceptance"],
          },
        },
      },
    },
  ];
}

function summarizeState(state: RunState): string {
  const pendingGate = Object.entries(state.gates).find(([, status]) => status === "pending")?.[0] ?? "none";
  const role = state.roles.at(-1);
  const roleFallback =
    role?.usedFallback === true ? (role.backend === "local" ? "local" : "sdk") : role ? "none" : "none";
  return `Run ${state.runId}: phase=${state.phase}, status=${state.status}, execution_mode=${state.executionMode}, pending_gate=${pendingGate}, role_fallback=${roleFallback}`;
}

function success(text: string, structuredContent?: Record<string, unknown>): ToolResult {
  return {
    isError: false,
    content: [{ type: "text", text }],
    structuredContent,
  };
}

function failure(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: message },
  };
}

export async function callDevCrewTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    if (name === "devcrew_start") {
      const state = await startOrchestratedWorkflow(withInferredHost(args) as never);
      await setActiveRun(state.cwd, state.runId);
      return success(`${summarizeState(state)}. Review ${state.artifacts.requirements}`, { state });
    }
    if (name === "devcrew_status") {
      const state = await getWorkflowStatus((await withActiveRun(args)) as never);
      return success(summarizeState(state), { state });
    }
    if (name === "devcrew_answer") {
      const state = await answerOrchestratedWorkflow((await withActiveRun(args)) as never);
      return success(`${summarizeState(state)}. Answer recorded.`, { state });
    }
    if (name === "devcrew_approve") {
      const state = await approveOrchestratedWorkflow((await withActiveRun(args)) as never);
      return success(`${summarizeState(state)}. Gate approved.`, { state });
    }
    if (name === "devcrew_reject") {
      const state = await rejectOrchestratedWorkflow((await withActiveRun(args)) as never);
      return success(`${summarizeState(state)}. Gate rejected.`, { state });
    }
    if (name === "devcrew_continue") {
      const state = await continueOrchestratedWorkflow((await withActiveRun(args)) as never);
      return success(`${summarizeState(state)}.`, { state });
    }
    if (name === "devcrew_artifact") {
      const artifact = await getArtifact((await withActiveRun(args)) as never);
      return success(artifact.content, { artifact });
    }
    throw new Error(`Unknown DevCrew tool: ${name}`);
  } catch (error) {
    return failure(error);
  }
}
