import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";

import { runRole } from "../../adapters/src/index.js";
import type { RoleRunInput } from "../../adapters/src/index.js";
import {
  answerWorkflow,
  artifactForPhase,
  artifactPath,
  ARTIFACTS,
  discoverVerifyCommands,
  gateForPhase,
  getWorkflowStatus,
  readConfig,
  rejectWorkflow,
  renderArtifact,
  saveState,
  startWorkflow,
  type AnswerWorkflowInput,
  type ArtifactName,
  type Phase,
  type RejectWorkflowInput,
  type RoleResult,
  type RunRef,
  type RunState,
  type StartWorkflowInput,
  type VerificationResult,
} from "../../core/src/index.js";

// Hard cap so a hung apply/verify command cannot block the serialized MCP loop.
const COMMAND_TIMEOUT_MS = 300_000;

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

async function runGit(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolveResult) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => resolveResult({ exitCode: 1, stdout: "" }));
    child.on("close", (code) => resolveResult({ exitCode: code ?? 1, stdout: stdout || stderr }));
  });
}

async function listChangedLines(cwd: string): Promise<string[]> {
  const result = await runShellCommand("git status --porcelain -uall", cwd, 30_000);
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

// Files attributable to this run are the porcelain lines that appeared (or
// changed status) since the baseline captured before the role executed. This
// keeps a user's pre-existing uncommitted edits out of the changed-files list.
// The porcelain status prefix is preserved for review (?? = new, M = modified).
export function changedSinceBaseline(baseline: string[], current: string[]): string[] {
  const baselineLines = new Set(baseline);
  return current.filter((line) => !baselineLines.has(line));
}

// Strip the two-character porcelain status plus its separating space. For
// rename entries ("R  old -> new") the destination path is what remains
// relevant, so keep only the post-arrow path when present.
export function porcelainPath(line: string): string {
  const raw = line.slice(3).trim();
  const arrow = raw.indexOf(" -> ");
  return arrow >= 0 ? raw.slice(arrow + 4) : raw;
}

export interface RevertDeps {
  runGit?: (args: string[], cwd: string) => Promise<{ exitCode: number; stdout: string }>;
  removeFile?: (absolutePath: string) => Promise<void>;
}

// Roll back implementer edits when an apply-mode gate is rejected.
// Only the files this run introduced/changed are reverted, so unrelated work in
// the repository is preserved. Tracked files are restored from HEAD; files that
// did not exist in HEAD are deleted. Failures are surfaced to the MCP caller.
export async function revertChangedFiles(
  cwd: string,
  changedFiles: string[],
  deps: RevertDeps = {},
): Promise<void> {
  const git = deps.runGit ?? runGit;
  const removeFile = deps.removeFile ?? ((absolutePath: string) => rm(absolutePath, { force: true }));
  for (const line of changedFiles) {
    const file = porcelainPath(line);
    if (!file) {
      continue;
    }
    const tracked = await git(["cat-file", "-e", `HEAD:${file}`], cwd);
    if (tracked.exitCode === 0) {
      const restored = await git(["restore", "--source=HEAD", "--", file], cwd);
      if (restored.exitCode !== 0) {
        throw new Error(`Failed to restore ${file}: ${restored.stdout || "git restore failed"}`);
      }
    } else {
      try {
        await removeFile(resolvePath(cwd, file));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to remove ${file}: ${message}`);
      }
    }
  }
}

async function runConfiguredVerification(state: RunState): Promise<VerificationResult[]> {
  const config = await readConfig(state.cwd);
  const configuredCommands = config.verifyCommands.filter((command) => command.trim().length > 0);
  const commands = configuredCommands.length > 0 ? configuredCommands : await discoverVerifyCommands(state.cwd);
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

  // Snapshot the working tree before an apply-mode implementer runs so the
  // changed-files list reflects only this run's edits.
  const applyingImplementation = state.executionMode === "apply" && state.phase === "implementation";
  const implementationBaseline = applyingImplementation ? await listChangedLines(state.cwd) : [];

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

  if (applyingImplementation) {
    state.changedFiles = changedSinceBaseline(implementationBaseline, await listChangedLines(state.cwd));
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

export async function rejectOrchestratedWorkflow(input: RejectWorkflowInput): Promise<RunState> {
  const before = await getWorkflowStatus(input);
  const state = await rejectWorkflow(input);

  // Roll back implementer edits when an apply-mode implementation gate is
  // rejected so the next attempt starts from a clean working tree.
  if (
    before.executionMode === "apply" &&
    before.phase === "implementation" &&
    before.changedFiles.length > 0
  ) {
    await revertChangedFiles(before.cwd, before.changedFiles);
    state.changedFiles = [];
    return saveState(state);
  }

  return state;
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
