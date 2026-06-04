import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { runRole } from "../../adapters/src/index.js";
import type { RoleRunInput } from "../../adapters/src/index.js";
import {
  answerWorkflow,
  artifactForPhase,
  artifactPath,
  ARTIFACTS,
  gateForPhase,
  getWorkflowStatus,
  renderArtifact,
  saveState,
  startWorkflow,
  type AnswerWorkflowInput,
  type ArtifactName,
  type Phase,
  type RoleResult,
  type RunRef,
  type RunState,
  type StartWorkflowInput,
} from "../../core/src/index.js";

type RoleRunner = (input: RoleRunInput) => Promise<RoleResult>;

function roleForPhase(phase: Phase): RoleResult["role"] | undefined {
  const roles: Partial<Record<Phase, RoleResult["role"]>> = {
    requirements: "pm",
    architecture: "architect",
    implementation: "implementer",
    testing: "tester",
  };
  return roles[phase];
}

function priorArtifactNamesForPhase(phase: Phase): ArtifactName[] {
  const current = artifactForPhase(phase);
  const currentIndex = ARTIFACTS.indexOf(current);
  if (currentIndex <= 0) {
    return [];
  }
  return ARTIFACTS.slice(0, currentIndex);
}

async function writeMarkdownArtifact(state: RunState, artifact: ArtifactName, markdown: string): Promise<string> {
  const path = artifactPath(state.cwd, state.runId, artifact);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, markdown, "utf8");
  return path;
}

function fallbackNotice(result: RoleResult): string {
  if (!result.usedFallback) {
    return "";
  }
  if (result.backend === "local") {
    return `> DevCrew local fallback: this artifact uses the deterministic local planning template because the local backend does not call an external SDK.\n\n`;
  }
  return `> DevCrew SDK fallback: this artifact uses the deterministic planning template because the ${result.backend} SDK was unavailable.\n> Reason: ${result.summary}\n\n`;
}

async function readPriorArtifacts(state: RunState): Promise<Record<string, string>> {
  const priorArtifacts: Record<string, string> = {};
  for (const name of priorArtifactNamesForPhase(state.phase)) {
    const path = state.artifacts[name];
    if (!path) {
      continue;
    }
    priorArtifacts[name] = await readFile(path, "utf8");
  }
  return priorArtifacts;
}

async function runCurrentPhaseRole(state: RunState, runner: RoleRunner = runRole): Promise<RunState> {
  const gate = gateForPhase(state.phase);
  const role = roleForPhase(state.phase);
  if (!gate || !role) {
    const artifact = artifactForPhase(state.phase);
    const markdown = renderArtifact(artifact, state);
    state.artifacts[artifact] = await writeMarkdownArtifact(state, artifact, markdown);
    state.phase = "complete";
    state.status = "complete";
    return saveState(state);
  }

  const artifact = artifactForPhase(state.phase);
  const path = artifactPath(state.cwd, state.runId, artifact);
  const result = await runner({
    backend: state.backend,
    role,
    phase: state.phase,
    request: state.request,
    mode: state.mode,
    cwd: state.cwd,
    standards: state.standards.combined,
    artifactPath: path,
    answers: state.answers.map((entry) => entry.answer),
    feedback: state.feedback.map((entry) => `${entry.gate}: ${entry.message}`),
    priorArtifacts: await readPriorArtifacts(state),
  });

  // When the backend cannot run a real SDK we keep a single deterministic
  // artifact source by rendering the rich phase template from the core layer.
  const markdown = result.usedFallback ? `${fallbackNotice(result)}${renderArtifact(artifact, state)}` : result.markdown;
  state.roles.push({ ...result, markdown });
  state.artifacts[artifact] = await writeMarkdownArtifact(state, artifact, markdown);
  state.gates[gate] = "pending";
  state.status = "awaiting_approval";
  return saveState(state);
}

export async function startOrchestratedWorkflow(input: StartWorkflowInput, runner: RoleRunner = runRole): Promise<RunState> {
  const state = await startWorkflow(input, { skipArtifactWrite: true });
  return runCurrentPhaseRole(state, runner);
}

export async function continueOrchestratedWorkflow(input: RunRef, runner: RoleRunner = runRole): Promise<RunState> {
  const state = await getWorkflowStatus(input);
  if (state.status === "awaiting_approval" || state.status === "awaiting_input" || state.status === "complete") {
    return state;
  }

  return runCurrentPhaseRole(state, runner);
}

export async function answerOrchestratedWorkflow(input: AnswerWorkflowInput, runner: RoleRunner = runRole): Promise<RunState> {
  const state = await answerWorkflow(input, { skipArtifactWrite: true });
  const gate = gateForPhase(state.phase);
  const role = roleForPhase(state.phase);
  if (!gate || !role) {
    return state;
  }

  // Re-run the current phase role so the artifact reflects the new answer and
  // any rejection feedback, instead of reverting to the static template.
  return runCurrentPhaseRole(state, runner);
}
