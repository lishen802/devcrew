import { spawn } from "node:child_process";
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
  readConfig,
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
  type VerificationResult,
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

function now(): string {
  return new Date().toISOString();
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

async function runShellCommand(command: string, cwd: string): Promise<VerificationResult> {
  const startedAt = now();
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const maxOutputBytes = 64_000;
    let collected = 0;

    function collect(chunk: Buffer): void {
      if (collected >= maxOutputBytes) {
        return;
      }
      const slice = chunk.subarray(0, Math.max(0, maxOutputBytes - collected));
      chunks.push(slice);
      collected += slice.length;
    }

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => {
      resolve({
        command,
        exitCode: 1,
        output: error.message,
        startedAt,
        completedAt: now(),
      });
    });
    child.on("close", (code) => {
      resolve({
        command,
        exitCode: code ?? 1,
        output: Buffer.concat(chunks).toString("utf8").trim(),
        startedAt,
        completedAt: now(),
      });
    });
  });
}

async function collectChangedFiles(cwd: string): Promise<string[]> {
  const result = await runShellCommand("git status --porcelain -uall", cwd);
  if (result.exitCode !== 0) {
    return [];
  }
  return result.output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => {
      const path = line.slice(3);
      return !path.startsWith(".devcrew/") && !path.startsWith("docs/devcrew/");
    });
}

async function runConfiguredVerification(state: RunState): Promise<VerificationResult[]> {
  const config = await readConfig(state.cwd);
  const commands = config.verifyCommands.filter((command) => command.trim().length > 0);
  const results: VerificationResult[] = [];
  for (const command of commands) {
    results.push(await runShellCommand(command, state.cwd));
  }
  return results;
}

function changedFilesBlock(changedFiles: string[]): string {
  if (changedFiles.length === 0) {
    return "No changed files were detected.";
  }
  return changedFiles.map((file) => `- ${file}`).join("\n");
}

function verificationBlock(results: VerificationResult[]): string {
  if (results.length === 0) {
    return "No verification commands were configured.";
  }
  return results
    .map(
      (result) =>
        `### ${result.command}\n\nExit Code: ${result.exitCode}\n\nOutput:\n\n\`\`\`text\n${result.output || "(no output)"}\n\`\`\``,
    )
    .join("\n\n");
}

function appendExecutionSections(artifact: ArtifactName, markdown: string, state: RunState): string {
  if (artifact === "implementation-plan" && !markdown.includes("## Changed Files")) {
    return `${markdown.trim()}\n\n## Changed Files\n\n${changedFilesBlock(state.changedFiles)}\n`;
  }
  if (artifact === "test-report" && !markdown.includes("## Acceptance Evidence")) {
    return `${markdown.trim()}\n\n## Acceptance Evidence\n\n${verificationBlock(state.verification)}\n`;
  }
  return markdown;
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
    executionMode: state.executionMode,
    cwd: state.cwd,
    standards: state.standards.combined,
    artifactPath: path,
    answers: state.answers.map((entry) => entry.answer),
    feedback: state.feedback.map((entry) => `${entry.gate}: ${entry.message}`),
    priorArtifacts: await readPriorArtifacts(state),
  });

  if (state.executionMode === "apply" && state.phase === "implementation") {
    state.changedFiles = await collectChangedFiles(state.cwd);
  }
  if (state.executionMode === "apply" && state.phase === "testing") {
    state.verification = await runConfiguredVerification(state);
  }

  // When the backend cannot run a real SDK we keep a single deterministic
  // artifact source by rendering the rich phase template from the core layer.
  const baseMarkdown = result.usedFallback ? `${fallbackNotice(result)}${renderArtifact(artifact, state)}` : result.markdown;
  const markdown = appendExecutionSections(artifact, baseMarkdown, state);
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
