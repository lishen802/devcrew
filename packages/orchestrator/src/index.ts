import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { runRole } from "../../adapters/src/index.js";
import {
  artifactPath,
  getWorkflowStatus,
  saveState,
  startWorkflow,
  type ArtifactName,
  type GateName,
  type Phase,
  type RoleResult,
  type RunRef,
  type RunState,
  type StartWorkflowInput,
} from "../../core/src/index.js";

function roleForPhase(phase: Phase): RoleResult["role"] | undefined {
  const roles: Partial<Record<Phase, RoleResult["role"]>> = {
    requirements: "pm",
    architecture: "architect",
    implementation: "implementer",
    testing: "tester",
  };
  return roles[phase];
}

function gateForPhase(phase: Phase): GateName | undefined {
  if (phase === "requirements" || phase === "architecture" || phase === "implementation" || phase === "testing") {
    return phase;
  }
  return undefined;
}

function artifactForPhase(phase: Phase): ArtifactName {
  const artifacts: Record<Phase, ArtifactName> = {
    requirements: "requirements",
    architecture: "architecture",
    implementation: "implementation-plan",
    testing: "test-report",
    acceptance: "acceptance",
    complete: "acceptance",
  };
  return artifacts[phase];
}

async function writeMarkdownArtifact(state: RunState, artifact: ArtifactName, markdown: string): Promise<string> {
  const path = artifactPath(state.cwd, state.runId, artifact);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, markdown, "utf8");
  return path;
}

async function runCurrentPhaseRole(state: RunState): Promise<RunState> {
  const gate = gateForPhase(state.phase);
  const role = roleForPhase(state.phase);
  if (!gate || !role) {
    state.status = "complete";
    return saveState(state);
  }

  const artifact = artifactForPhase(state.phase);
  const path = artifactPath(state.cwd, state.runId, artifact);
  const result = await runRole({
    backend: state.backend,
    role,
    phase: state.phase,
    request: state.request,
    mode: state.mode,
    cwd: state.cwd,
    standards: state.standards.combined,
    artifactPath: path,
  });

  state.roles.push(result);
  state.artifacts[artifact] = await writeMarkdownArtifact(state, artifact, result.markdown);
  state.gates[gate] = "pending";
  state.status = "awaiting_approval";
  return saveState(state);
}

export async function startOrchestratedWorkflow(input: StartWorkflowInput): Promise<RunState> {
  const state = await startWorkflow(input);
  return runCurrentPhaseRole(state);
}

export async function continueOrchestratedWorkflow(input: RunRef): Promise<RunState> {
  const state = await getWorkflowStatus(input);
  if (state.status === "awaiting_approval" || state.status === "awaiting_input" || state.status === "complete") {
    return state;
  }

  return runCurrentPhaseRole(state);
}
