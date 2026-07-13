import { randomUUID } from "node:crypto";

import { ensureConfig } from "./config.js";
import { readArtifact, writeArtifact } from "./artifacts.js";
import { discoverStandards } from "./standards.js";
import { loadState, saveState } from "./store.js";
import {
  parseAnswer,
  parseArtifactName,
  parseBackend,
  parseCwd,
  parseExecutionMode,
  parseExecutionPolicy,
  parseFeedback,
  parseGate,
  parseHost,
  parseOptionalNote,
  parseRequest,
  parseRunId,
  parseWaiverReason,
  parseWorkflowMode,
} from "./validation.js";
import type {
  AnswerWorkflowInput,
  ApproveWorkflowInput,
  ArtifactName,
  ArtifactReadResult,
  ArtifactRef,
  GateName,
  RejectWorkflowInput,
  RunRef,
  RunState,
  StartWorkflowInput,
  WaiveVerificationInput,
} from "./types.js";

function now(): string {
  return new Date().toISOString();
}

function newRunId(): string {
  return `dc-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function nextPhaseAfterGate(state: RunState, gate: GateName): RunState["phase"] {
  switch (gate) {
    case "requirements":
      return "architecture";
    case "architecture":
      return "implementation";
    case "implementation":
      return state.executionMode === "apply" ? "execution" : "testing";
    case "implementation-review":
      return "testing";
    case "testing":
      return "acceptance";
  }
}

export function artifactForPhase(phase: RunState["phase"]): ArtifactName {
  const artifactByPhase: Record<RunState["phase"], ArtifactName> = {
    requirements: "requirements",
    architecture: "architecture",
    implementation: "implementation-plan",
    execution: "implementation-review",
    review: "architecture-review",
    testing: "test-report",
    acceptance: "acceptance",
    complete: "acceptance",
  };
  return artifactByPhase[phase];
}

export function gateForPhase(phase: RunState["phase"]): GateName | undefined {
  if (phase === "review") {
    return "implementation-review";
  }
  if (
    phase === "requirements" ||
    phase === "architecture" ||
    phase === "implementation" ||
    phase === "testing"
  ) {
    return phase;
  }
  return undefined;
}

function assertPendingCurrentGate(state: RunState, gate: GateName): void {
  const expected = gateForPhase(state.phase);
  if (expected !== gate) {
    throw new Error(
      expected
        ? `Cannot act on ${gate} while current gate is ${expected}`
        : `Cannot act on ${gate} while workflow phase is ${state.phase}`,
    );
  }
  if (state.status !== "awaiting_approval" || state.gates[gate] !== "pending") {
    throw new Error(`Gate ${gate} is not pending approval`);
  }
}

async function writeCurrentArtifact(state: RunState): Promise<RunState> {
  const artifact = artifactForPhase(state.phase);
  const path = await writeArtifact(artifact, state);
  state.artifacts[artifact] = path;
  return state;
}

export interface WorkflowMutationOptions {
  skipArtifactWrite?: boolean;
}

export async function startWorkflow(input: StartWorkflowInput, options: WorkflowMutationOptions = {}): Promise<RunState> {
  const cwd = parseCwd(input.cwd);
  const host = parseHost(input.host);
  const mode = parseWorkflowMode(input.mode);
  const request = parseRequest(input.request);
  const config = await ensureConfig(cwd);
  const backend = input.backend ? parseBackend(input.backend) : config.defaultBackend === "host-preferred" ? host : config.defaultBackend;
  const executionMode = input.executionMode ? parseExecutionMode(input.executionMode) : config.executionMode;
  const executionPolicy = input.executionPolicy ? parseExecutionPolicy(input.executionPolicy) : "interactive-host";
  if (executionMode === "apply" && backend === "local") {
    throw new Error("DevCrew apply mode requires a codex or claude backend; local is plan-only");
  }
  const createdAt = now();
  const state: RunState = {
    version: 1,
    runId: newRunId(),
    cwd,
    host,
    mode,
    executionMode,
    executionPolicy,
    artifactDirectory: config.workflow.artifactDirectory,
    backend,
    request,
    phase: "requirements",
    status: "awaiting_approval",
    createdAt,
    updatedAt: createdAt,
    gates: {
      requirements: "pending",
      architecture: "not_started",
      implementation: "not_started",
      "implementation-review": "not_started",
      testing: "not_started",
    },
    artifacts: {},
    roles: [],
    pendingQuestions: [],
    answers: [],
    approvals: [],
    feedback: [],
    standards: await discoverStandards(cwd),
    changedFiles: [],
    implementationDiff: "",
    verification: [],
    verificationStatus: "not_run",
    lintResults: [],
  };

  if (!options.skipArtifactWrite) {
    await writeCurrentArtifact(state);
  }
  return saveState(state);
}

export async function getWorkflowStatus(input: RunRef): Promise<RunState> {
  return loadState(parseCwd(input.cwd), parseRunId(input.runId));
}

export async function continueWorkflow(input: RunRef): Promise<RunState> {
  const state = await getWorkflowStatus(input);
  if (
    state.status === "awaiting_approval" ||
    state.status === "awaiting_input" ||
    state.status === "awaiting_execution" ||
    state.status === "complete"
  ) {
    return state;
  }

  if (state.phase === "acceptance") {
    await writeCurrentArtifact(state);
    state.phase = "complete";
    state.status = "complete";
    return saveState(state);
  }

  if (state.phase === "execution") {
    throw new Error("DevCrew execution phase requires orchestrated continuation");
  }

  const gate = gateForPhase(state.phase);
  if (!gate) {
    state.status = "complete";
    return saveState(state);
  }
  state.gates[gate] = "pending";
  state.status = "awaiting_approval";
  await writeCurrentArtifact(state);
  return saveState(state);
}

export async function validateWorkflowApproval(input: ApproveWorkflowInput): Promise<RunState> {
  const state = await getWorkflowStatus(input);
  const gate = parseGate(input.gate);
  if (state.gates[gate] === "approved") {
    return state;
  }
  assertPendingCurrentGate(state, gate);
  parseOptionalNote(input.note);
  return state;
}

export async function approveWorkflow(input: ApproveWorkflowInput): Promise<RunState> {
  const state = await validateWorkflowApproval(input);
  const gate = parseGate(input.gate);
  if (state.gates[gate] === "approved") {
    return state;
  }
  state.gates[gate] = "approved";
  state.approvals.push({
    gate,
    note: parseOptionalNote(input.note),
    createdAt: now(),
  });

  const nextPhase = nextPhaseAfterGate(state, gate);
  state.phase = nextPhase;
  state.status = "ready";
  return saveState(state);
}

export async function rejectWorkflow(input: RejectWorkflowInput): Promise<RunState> {
  const state = await getWorkflowStatus(input);
  const gate = parseGate(input.gate);
  if (state.gates[gate] === "rejected") {
    return state;
  }
  assertPendingCurrentGate(state, gate);
  state.gates[gate] = "rejected";
  state.status = "awaiting_input";
  state.feedback.push({
    gate,
    message: parseFeedback(input.feedback),
    createdAt: now(),
  });
  return saveState(state);
}

export async function answerWorkflow(input: AnswerWorkflowInput, options: WorkflowMutationOptions = {}): Promise<RunState> {
  const state = await getWorkflowStatus(input);
  const gate = gateForPhase(state.phase);
  if (state.status === "awaiting_input" && state.pendingQuestions.length > 0 && state.phase === "requirements") {
    state.answers.push({
      answer: parseAnswer(input.answer),
      createdAt: now(),
    });
    state.pendingQuestions = [];
    state.status = "ready";
    return saveState(state);
  }
  if (state.status !== "awaiting_input" || !gate || state.gates[gate] !== "rejected") {
    throw new Error("Workflow must be awaiting_input at a rejected current gate before recording an answer");
  }
  state.answers.push({
    answer: parseAnswer(input.answer),
    createdAt: now(),
  });
  state.gates[gate] = "pending";
  state.status = "awaiting_approval";
  if (!options.skipArtifactWrite) {
    await writeCurrentArtifact(state);
  }
  return saveState(state);
}

export async function waiveVerificationWorkflow(input: WaiveVerificationInput): Promise<RunState> {
  const state = await getWorkflowStatus(input);
  if (
    state.executionMode !== "apply" ||
    state.phase !== "testing" ||
    state.status !== "awaiting_input" ||
    state.gates.testing !== "rejected" ||
    state.verificationStatus !== "failed"
  ) {
    throw new Error("A verification waiver is only available after failed apply-mode testing");
  }
  state.verificationWaiver = {
    reason: parseWaiverReason(input.reason),
    createdAt: now(),
  };
  state.gates.testing = "pending";
  state.status = "awaiting_approval";
  return saveState(state);
}

export async function getArtifact(input: ArtifactRef): Promise<ArtifactReadResult> {
  const state = await getWorkflowStatus(input);
  return readArtifact(state, parseArtifactName(input.name));
}
