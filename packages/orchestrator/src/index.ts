import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { runRole } from "../../adapters/src/index.js";
import type { RoleRunInput } from "../../adapters/src/index.js";
import {
  answerWorkflow,
  approveWorkflow,
  artifactForPhase,
  artifactPath,
  ARTIFACTS,
  discoverCoverageCommands,
  discoverLintCommands,
  discoverVerifyCommands,
  gateForPhase,
  getWorkflowStatus,
  readConfig,
  rejectWorkflow,
  renderArtifact,
  saveState,
  startWorkflow,
  validateWorkflowApproval,
  waiveVerificationWorkflow,
  type AnswerWorkflowInput,
  type ApproveWorkflowInput,
  type ArtifactName,
  type CompleteExecutionInput,
  type Phase,
  type RejectWorkflowInput,
  type RoleResult,
  type RunRef,
  type RunState,
  type StartWorkflowInput,
  type VerificationResult,
  type VerificationStatus,
  type WaiveVerificationInput,
} from "../../core/src/index.js";
import {
  captureExecutionChanges,
  cleanupExecutionWorkspace,
  ensureExecutionWorkspace,
  promoteExecutionChanges,
  rollbackPromotedExecutionChanges,
} from "./worktree.js";

// Hard cap so a hung apply/verify command cannot block the serialized MCP loop.
const COMMAND_TIMEOUT_MS = 300_000;

type RoleRunner = (input: RoleRunInput) => Promise<RoleResult>;

function roleForPhase(phase: Phase): RoleResult["role"] | undefined {
  const roles: Partial<Record<Phase, RoleResult["role"]>> = {
    requirements: "pm",
    architecture: "architect",
    implementation: "implementer",
    execution: "implementer",
    testing: "tester",
  };
  return roles[phase];
}

function conductorDecision(state: RunState, role: RoleResult["role"], gate: string): RoleResult {
  const summary = `Conductor routed ${state.phase} phase to ${role} and prepared the ${gate} gate.`;
  return {
    role: "conductor",
    backend: state.backend,
    summary,
    markdown: `# Conductor Decision\n\n${summary}\n`,
    usedFallback: false,
  };
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
  const reason = result.summary.includes("output failed validation")
    ? `the ${result.backend} SDK did not return a valid artifact`
    : `the ${result.backend} SDK was unavailable`;
  return `> DevCrew SDK fallback: this artifact uses the deterministic planning template because ${reason}.\n> Reason: ${result.summary}\n\n`;
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

export async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number = COMMAND_TIMEOUT_MS,
): Promise<VerificationResult> {
  const startedAt = now();
  return new Promise((resolveResult) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const maxOutputBytes = 64_000;
    let collected = 0;
    let timedOut = false;
    let settled = false;

    function collect(chunk: Buffer): void {
      if (collected >= maxOutputBytes) {
        return;
      }
      const slice = chunk.subarray(0, Math.max(0, maxOutputBytes - collected));
      chunks.push(slice);
      collected += slice.length;
    }

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    killTimer.unref();

    function finish(result: VerificationResult): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(killTimer);
      resolveResult(result);
    }

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => {
      finish({ command, exitCode: 1, output: error.message, startedAt, completedAt: now() });
    });
    child.on("close", (code) => {
      const base = Buffer.concat(chunks).toString("utf8").replace(/\s+$/u, "");
      const output = timedOut
        ? `${base}\n[devcrew] command timed out after ${timeoutMs}ms`.trim()
        : base;
      finish({ command, exitCode: timedOut ? 124 : code ?? 1, output, startedAt, completedAt: now() });
    });
  });
}

async function runCommands(commands: string[], cwd: string): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  for (const command of commands) {
    results.push(await runShellCommand(command, cwd));
  }
  return results;
}

function uniqueCommands(commands: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const command of commands) {
    if (seen.has(command)) {
      continue;
    }
    seen.add(command);
    unique.push(command);
  }
  return unique;
}

// Tester verification runs the normal verification path first, then coverage
// as supplemental evidence. Configured commands win per category; otherwise
// DevCrew discovers common project commands.
async function runConfiguredVerification(state: RunState, commandCwd: string): Promise<VerificationResult[]> {
  const config = await readConfig(state.cwd);
  const configuredVerify = config.verifyCommands.filter((command) => command.trim().length > 0);
  const configuredCoverage = (config.coverageCommands ?? []).filter((command) => command.trim().length > 0);
  const verifyCommands = configuredVerify.length > 0 ? configuredVerify : await discoverVerifyCommands(commandCwd);
  const coverageCommands = configuredCoverage.length > 0 ? configuredCoverage : await discoverCoverageCommands(commandCwd);
  const commands = uniqueCommands([...verifyCommands, ...coverageCommands]);
  return runCommands(commands, commandCwd);
}

// Implementer apply runs lint/format/typecheck so reviewers see standards
// compliance evidence. Configured lintCommands win, otherwise discover them.
async function runConfiguredLint(state: RunState, commandCwd: string): Promise<VerificationResult[]> {
  const config = await readConfig(state.cwd);
  const configuredLint = (config.lintCommands ?? []).filter((command) => command.trim().length > 0);
  const commands = configuredLint.length > 0 ? configuredLint : await discoverLintCommands(commandCwd);
  return runCommands(commands, commandCwd);
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

function verificationStatusFor(results: VerificationResult[]): VerificationStatus {
  if (results.length === 0) {
    return "not_run";
  }
  return results.every((result) => result.exitCode === 0) ? "passed" : "failed";
}

function setTestingGateFromVerification(state: RunState): void {
  if (state.verificationStatus === "failed") {
    state.gates.testing = "rejected";
    state.status = "awaiting_input";
    state.feedback.push({
      gate: "testing",
      message: "Automated verification failed. Inspect the test report, revise the implementation, or record an explicit verification waiver with its reason.",
      createdAt: now(),
    });
    return;
  }
  state.gates.testing = "pending";
  state.status = "awaiting_approval";
}

function executionInstructions(state: RunState, phase: "execution" | "testing", workspacePath: string): string {
  if (phase === "execution") {
    return `Use the native ${state.host} host agent to implement the approved change in ${workspacePath}. Do not modify the requester checkout at ${state.cwd}. When complete, call devcrew_complete_execution with a concise summary.`;
  }
  return `Use the native ${state.host} host agent to validate the approved change in ${workspacePath}. Then call devcrew_complete_execution with a concise summary and each command's exit code and output.`;
}

function hostCompletionResult(state: RunState, summary: string): RoleResult {
  const role = state.phase === "execution" ? "implementer" : "tester";
  const artifact = artifactForPhase(state.phase);
  return {
    role,
    backend: state.backend,
    summary: `${role} completed through the native ${state.host} host: ${summary}`,
    markdown: `${renderArtifact(artifact, state).trim()}\n\n## Native Host Summary\n\n${summary}\n`,
    usedFallback: false,
  };
}

function parseCompletionSummary(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("summary must be a non-empty string");
  }
  return value.trim();
}

function parseCompletionVerification(value: unknown): VerificationResult[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("verification must be an array");
  }
  return value.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.command !== "string" ||
      entry.command.trim().length === 0 ||
      !Number.isInteger(entry.exitCode) ||
      typeof entry.output !== "string" ||
      typeof entry.startedAt !== "string" ||
      typeof entry.completedAt !== "string"
    ) {
      throw new Error(`verification[${index}] must include command, integer exitCode, output, startedAt, and completedAt`);
    }
    return {
      command: entry.command.trim(),
      exitCode: entry.exitCode,
      output: entry.output,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
    };
  });
}

function appendExecutionSections(artifact: ArtifactName, markdown: string, state: RunState): string {
  if (artifact === "test-report") {
    let content = markdown.trim();
    if (!content.includes("## Acceptance Evidence")) {
      content += `\n\n## Acceptance Evidence\n\n${verificationBlock(state.verification)}`;
    }
    if (!content.includes("## Verification Outcome")) {
      content += `\n\n## Verification Outcome\n\nStatus: ${state.verificationStatus}`;
    }
    if (state.verificationWaiver && !content.includes("## Verification Waiver")) {
      content += `\n\n## Verification Waiver\n\nReason: ${state.verificationWaiver.reason}\nRecorded At: ${state.verificationWaiver.createdAt}`;
    }
    return `${content}\n`;
  }
  return markdown;
}

async function writeImplementationReview(state: RunState): Promise<void> {
  state.artifacts["implementation-review"] = await writeMarkdownArtifact(
    state,
    "implementation-review",
    renderArtifact("implementation-review", state),
  );
}

async function runCurrentPhaseRole(state: RunState, runner: RoleRunner = runRole): Promise<RunState> {
  if (state.phase === "execution") {
    if (state.executionMode !== "apply") {
      throw new Error("DevCrew execution phase requires apply mode");
    }
    const workspace = await ensureExecutionWorkspace(state);
    state.executionWorkspace = workspace;
    state.verification = [];
    state.verificationStatus = "not_run";
    delete state.verificationWaiver;
    delete state.artifacts["test-report"];
    await saveState(state);

    if (state.executionPolicy === "interactive-host") {
      state.executionInstruction = {
        phase: "execution",
        workspacePath: workspace.path,
        instructions: executionInstructions(state, "execution", workspace.path),
        createdAt: now(),
      };
      state.status = "awaiting_execution";
      return saveState(state);
    }

    const result = await runner({
      backend: state.backend,
      role: "implementer",
      phase: "execution",
      request: state.request,
      mode: state.mode,
      executionMode: "apply",
      executionPolicy: state.executionPolicy,
      cwd: workspace.path,
      standards: state.standards.combined,
      artifactPath: artifactPath(state.cwd, state.runId, "implementation-review"),
      answers: state.answers.map((entry) => entry.answer),
      feedback: state.feedback.map((entry) => `${entry.gate}: ${entry.message}`),
      priorArtifacts: await readPriorArtifacts(state),
    });
    await captureExecutionChanges(workspace);
    state.lintResults = await runConfiguredLint(state, workspace.path);
    const captured = await captureExecutionChanges(workspace);
    state.changedFiles = captured.changedFiles;
    state.implementationDiff = captured.patch;
    state.roles.push(result);
    state.executionInstruction = undefined;
    await writeImplementationReview(state);
    state.phase = "testing";
    state.status = "ready";
    return saveState(state);
  }

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
  const applyingTesting = state.executionMode === "apply" && state.phase === "testing";
  const roleCwd = applyingTesting ? state.executionWorkspace?.path : state.cwd;
  if (!roleCwd) {
    throw new Error("DevCrew apply testing requires an execution workspace");
  }
  state.roles.push(conductorDecision(state, role, gate));

  if (applyingTesting && state.executionPolicy === "interactive-host") {
    state.executionInstruction = {
      phase: "testing",
      workspacePath: roleCwd,
      instructions: executionInstructions(state, "testing", roleCwd),
      createdAt: now(),
    };
    state.status = "awaiting_execution";
    return saveState(state);
  }

  const result = await runner({
    backend: state.backend,
    role,
    phase: state.phase,
    request: state.request,
    mode: state.mode,
    executionMode: state.executionMode,
    executionPolicy: state.executionPolicy,
    cwd: roleCwd,
    standards: state.standards.combined,
    artifactPath: path,
    answers: state.answers.map((entry) => entry.answer),
    feedback: state.feedback.map((entry) => `${entry.gate}: ${entry.message}`),
    priorArtifacts: await readPriorArtifacts(state),
  });

  if (applyingTesting && state.executionWorkspace) {
    state.verification = await runConfiguredVerification(state, roleCwd);
    state.verificationStatus = verificationStatusFor(state.verification);
    const captured = await captureExecutionChanges(state.executionWorkspace);
    state.changedFiles = captured.changedFiles;
    state.implementationDiff = captured.patch;
    await writeImplementationReview(state);
  }

  // When the backend cannot run a real SDK we keep a single deterministic
  // artifact source by rendering the rich phase template from the core layer.
  const baseMarkdown = result.usedFallback ? `${fallbackNotice(result)}${renderArtifact(artifact, state)}` : result.markdown;
  const markdown = appendExecutionSections(artifact, baseMarkdown, state);
  state.roles.push({ ...result, markdown });
  state.artifacts[artifact] = await writeMarkdownArtifact(state, artifact, markdown);
  state.executionInstruction = undefined;
  if (applyingTesting) {
    setTestingGateFromVerification(state);
  } else {
    state.gates[gate] = "pending";
    state.status = "awaiting_approval";
  }
  return saveState(state);
}

export async function startOrchestratedWorkflow(input: StartWorkflowInput, runner: RoleRunner = runRole): Promise<RunState> {
  const state = await startWorkflow(input, { skipArtifactWrite: true });
  return runCurrentPhaseRole(state, runner);
}

export async function continueOrchestratedWorkflow(input: RunRef, runner: RoleRunner = runRole): Promise<RunState> {
  const state = await getWorkflowStatus(input);
  if (
    state.status === "awaiting_approval" ||
    state.status === "awaiting_input" ||
    state.status === "awaiting_execution" ||
    state.status === "complete"
  ) {
    return state;
  }

  return runCurrentPhaseRole(state, runner);
}

export async function approveOrchestratedWorkflow(input: ApproveWorkflowInput): Promise<RunState> {
  const before = await validateWorkflowApproval(input);
  const promotingTesting =
    input.gate === "testing" &&
    before.executionMode === "apply" &&
    before.phase === "testing" &&
    before.status === "awaiting_approval" &&
    before.gates.testing === "pending";
  const cleaningCompletedPromotion =
    input.gate === "testing" &&
    before.executionMode === "apply" &&
    before.gates.testing === "approved" &&
    before.executionWorkspace !== undefined;

  async function cleanupAfterApproval(state: RunState): Promise<RunState> {
    try {
      await cleanupExecutionWorkspace(state);
    } catch {
      return state;
    }
    state.executionWorkspace = undefined;
    try {
      return await saveState(state);
    } catch {
      return state;
    }
  }

  if (cleaningCompletedPromotion) {
    return cleanupAfterApproval(before);
  }
  if (promotingTesting) {
    if (before.verificationStatus === "failed" && !before.verificationWaiver) {
      throw new Error("Failed verification cannot be promoted without an explicit verification waiver");
    }
    await promoteExecutionChanges(before);
    let approved: RunState;
    try {
      approved = await approveWorkflow(input);
    } catch (error) {
      try {
        await rollbackPromotedExecutionChanges(before);
      } catch (rollbackError) {
        const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`DevCrew approval failed and promoted patch rollback failed: ${detail}`, { cause: error });
      }
      throw error;
    }
    return cleanupAfterApproval(approved);
  }

  return approveWorkflow(input);
}

export async function waiveOrchestratedVerification(input: WaiveVerificationInput): Promise<RunState> {
  const state = await waiveVerificationWorkflow(input);
  const reportPath = state.artifacts["test-report"];
  if (reportPath) {
    const report = await readFile(reportPath, "utf8");
    await writeFile(reportPath, appendExecutionSections("test-report", report, state), "utf8");
  }
  return state;
}

export async function completeOrchestratedExecution(input: CompleteExecutionInput): Promise<RunState> {
  const state = await getWorkflowStatus(input);
  const instruction = state.executionInstruction;
  if (
    state.executionMode !== "apply" ||
    state.executionPolicy !== "interactive-host" ||
    state.status !== "awaiting_execution" ||
    !instruction ||
    instruction.phase !== state.phase ||
    !state.executionWorkspace ||
    instruction.workspacePath !== state.executionWorkspace.path
  ) {
    throw new Error("DevCrew is not awaiting an interactive-host execution completion");
  }
  const summary = parseCompletionSummary(input.summary);

  if (state.phase === "execution") {
    if (input.verification !== undefined) {
      throw new Error("verification can only be submitted after interactive-host testing");
    }
    const captured = await captureExecutionChanges(state.executionWorkspace);
    state.changedFiles = captured.changedFiles;
    state.implementationDiff = captured.patch;
    state.lintResults = [];
    state.roles.push(hostCompletionResult(state, summary));
    state.executionInstruction = undefined;
    await writeImplementationReview(state);
    state.phase = "testing";
    state.status = "ready";
    return saveState(state);
  }

  if (state.phase !== "testing") {
    throw new Error(`Cannot complete interactive-host work during ${state.phase}`);
  }
  state.verification = parseCompletionVerification(input.verification);
  state.verificationStatus = verificationStatusFor(state.verification);
  const captured = await captureExecutionChanges(state.executionWorkspace);
  state.changedFiles = captured.changedFiles;
  state.implementationDiff = captured.patch;
  await writeImplementationReview(state);
  const result = hostCompletionResult(state, summary);
  const artifact = artifactForPhase(state.phase);
  const markdown = appendExecutionSections(artifact, result.markdown, state);
  state.roles.push({ ...result, markdown });
  state.artifacts[artifact] = await writeMarkdownArtifact(state, artifact, markdown);
  state.executionInstruction = undefined;
  setTestingGateFromVerification(state);
  return saveState(state);
}

export async function rejectOrchestratedWorkflow(input: RejectWorkflowInput): Promise<RunState> {
  return rejectWorkflow(input);
}

export async function answerOrchestratedWorkflow(input: AnswerWorkflowInput, runner: RoleRunner = runRole): Promise<RunState> {
  const before = await getWorkflowStatus(input);
  const state = await answerWorkflow(input, { skipArtifactWrite: true });
  if (
    before.executionMode === "apply" &&
    before.phase === "testing" &&
    before.gates.testing === "rejected"
  ) {
    state.phase = "execution";
    state.status = "ready";
    state.gates.testing = "not_started";
    return saveState(state);
  }

  const gate = gateForPhase(state.phase);
  const role = roleForPhase(state.phase);
  if (!gate || !role) {
    return state;
  }

  // Re-run the current phase role so the artifact reflects the new answer and
  // any rejection feedback, instead of reverting to the static template.
  return runCurrentPhaseRole(state, runner);
}
