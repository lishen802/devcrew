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
  parseFeedback,
  parseGate,
  parseHost,
  parseOptionalNote,
  parseRequest,
  parseRunId,
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
} from "./types.js";

function now(): string {
  return new Date().toISOString();
}

function newRunId(): string {
  return `af-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function nextPhaseAfterGate(gate: GateName): RunState["phase"] {
  const nextByGate: Record<GateName, RunState["phase"]> = {
    requirements: "architecture",
    architecture: "implementation",
    implementation: "testing",
    testing: "acceptance",
  };
  return nextByGate[gate];
}

export function artifactForPhase(phase: RunState["phase"]): ArtifactName {
  const artifactByPhase: Record<RunState["phase"], ArtifactName> = {
    requirements: "requirements",
    architecture: "architecture",
    implementation: "implementation-plan",
    testing: "test-report",
    acceptance: "acceptance",
    complete: "acceptance",
  };
  return artifactByPhase[phase];
}

export function gateForPhase(phase: RunState["phase"]): GateName | undefined {
  if (phase === "requirements" || phase === "architecture" || phase === "implementation" || phase === "testing") {
    return phase;
  }
  return undefined;
}

function assertCurrentGate(state: RunState, gate: GateName): void {
  const expected = gateForPhase(state.phase);
  if (expected && expected !== gate) {
    throw new Error(`Cannot act on ${gate} while current gate is ${expected}`);
  }
}

async function writeCurrentArtifact(state: RunState): Promise<RunState> {
  const artifact = artifactForPhase(state.phase);
  const path = await writeArtifact(artifact, state);
  state.artifacts[artifact] = path;
  return state;
}

export async function startWorkflow(input: StartWorkflowInput, skipArtifactWrite = false): Promise<RunState> {
  const cwd = parseCwd(input.cwd);
  const host = parseHost(input.host);
  const mode = parseWorkflowMode(input.mode);
  const request = parseRequest(input.request);
  const config = await ensureConfig(cwd);
  const backend = input.backend ? parseBackend(input.backend) : config.defaultBackend === "host-preferred" ? host : config.defaultBackend;
  const createdAt = now();
  const state: RunState = {
    version: 1,
    runId: newRunId(),
    cwd,
    host,
    mode,
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
      testing: "not_started",
    },
    artifacts: {},
    roles: [],
    answers: [],
    approvals: [],
    feedback: [],
    standards: await discoverStandards(cwd),
  };

  if (!skipArtifactWrite) {
    await writeCurrentArtifact(state);
  }
  return saveState(state);
}

export async function getWorkflowStatus(input: RunRef): Promise<RunState> {
  return loadState(parseCwd(input.cwd), parseRunId(input.runId));
}

export async function continueWorkflow(input: RunRef): Promise<RunState> {
  const state = await getWorkflowStatus(input);
  if (state.status === "awaiting_approval" || state.status === "awaiting_input" || state.status === "complete") {
    return state;
  }

  if (state.phase === "acceptance") {
    await writeCurrentArtifact(state);
    state.phase = "complete";
    state.status = "complete";
    return saveState(state);
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

export async function approveWorkflow(input: ApproveWorkflowInput): Promise<RunState> {
  const state = await getWorkflowStatus(input);
  const gate = parseGate(input.gate);
  assertCurrentGate(state, gate);
  state.gates[gate] = "approved";
  state.approvals.push({
    gate,
    note: parseOptionalNote(input.note),
    createdAt: now(),
  });

  const nextPhase = nextPhaseAfterGate(gate);
  state.phase = nextPhase;
  if (nextPhase === "acceptance") {
    await writeCurrentArtifact(state);
    state.phase = "complete";
    state.status = "complete";
  } else {
    state.status = "ready";
  }
  return saveState(state);
}

export async function rejectWorkflow(input: RejectWorkflowInput): Promise<RunState> {
  const state = await getWorkflowStatus(input);
  const gate = parseGate(input.gate);
  assertCurrentGate(state, gate);
  state.gates[gate] = "rejected";
  state.status = "awaiting_input";
  state.feedback.push({
    gate,
    message: parseFeedback(input.feedback),
    createdAt: now(),
  });
  return saveState(state);
}

export async function answerWorkflow(input: AnswerWorkflowInput, skipArtifactWrite = false): Promise<RunState> {
  const state = await getWorkflowStatus(input);
  state.answers.push({
    answer: parseAnswer(input.answer),
    createdAt: now(),
  });
  const gate = gateForPhase(state.phase);
  if (gate) {
    state.gates[gate] = "pending";
    state.status = "awaiting_approval";
  }
  if (!skipArtifactWrite) {
    await writeCurrentArtifact(state);
  }
  return saveState(state);
}

export async function getArtifact(input: ArtifactRef): Promise<ArtifactReadResult> {
  const state = await getWorkflowStatus(input);
  return readArtifact(state, parseArtifactName(input.name));
}
