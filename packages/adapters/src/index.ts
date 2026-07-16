import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, join, sep } from "node:path";

import { DEVCREW_NPM_PACKAGE, ROLE_SECTIONS } from "../../core/src/index.js";
import type {
  ArtifactName,
  BackendName,
  ExecutionMode,
  ExecutionPolicy,
  Host,
  Phase,
  StructuredRoleData,
  RoleResult,
  RunState,
  WorkflowMode,
} from "../../core/src/index.js";

export interface BackendResolutionInput {
  host: Host;
  configuredBackend?: BackendName | "host-preferred";
}

export interface RoleRunInput {
  backend: BackendName;
  role: Exclude<RoleResult["role"], "conductor">;
  phase: Phase;
  request: string;
  mode: WorkflowMode;
  executionMode?: ExecutionMode;
  executionPolicy?: ExecutionPolicy;
  cwd: string;
  standards: string;
  artifactPath: string;
  answers?: string[];
  feedback?: string[];
  priorArtifacts?: Record<string, string>;
}

export function resolveBackendName(input: BackendResolutionInput): BackendName {
  if (input.configuredBackend && input.configuredBackend !== "host-preferred") {
    return input.configuredBackend;
  }
  return input.host;
}

// Prompt-formatted role sections derived from the shared ROLE_SECTIONS constant.
export function roleGuidance(role: RoleResult["role"]): string[] {
  const sections = ROLE_SECTIONS[role as keyof typeof ROLE_SECTIONS];
  if (!sections || sections.length === 0) {
    return [];
  }
  const lines = ["Produce these exact H2 sections:"];
  for (const section of sections) {
    lines.push(`## ${section.heading}`, `Guidance: ${section.description}.`);
  }
  return lines;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function missingRoleSections(role: RoleResult["role"], markdown: string): string[] {
  const sections = ROLE_SECTIONS[role as keyof typeof ROLE_SECTIONS];
  if (!sections || sections.length === 0) {
    return [];
  }
  return sections
    .map((section) => section.heading)
    .filter((heading) => !new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "imu").test(markdown));
}

export class RoleOutputValidationError extends Error {
  constructor(role: RoleResult["role"], missingSections: string[]) {
    super(`DevCrew ${role} output is missing required sections: ${missingSections.join(", ")}`);
    this.name = "RoleOutputValidationError";
  }
}

export function assertRoleSections(role: RoleResult["role"], markdown: string): void {
  const missingSections = missingRoleSections(role, markdown);
  if (missingSections.length > 0) {
    throw new RoleOutputValidationError(role, missingSections);
  }
}

export function extractOpenQuestions(markdown: string): string[] {
  const match = /^##\s+Open Questions\s*$(.*?)(?=^##\s|(?![\s\S]))/ims.exec(markdown);
  if (!match) {
    return [];
  }
  const questions: string[] = [];
  for (const line of match[1].split("\n")) {
    const question = /^\s*[-*]\s+(.+?)\s*$/u.exec(line)?.[1]?.trim();
    if (question && !/^(none|n\/a|no open questions)\.?$/i.test(question)) {
      questions.push(question);
    }
  }
  return questions;
}

export function extractArchitectureReviewDecision(markdown: string): "approved" | "changes_required" | undefined {
  const section = /^##\s+Review Decision\s*$(.*?)(?=^##\s|(?![\s\S]))/ims.exec(markdown)?.[1] ?? "";
  const match = /^Decision:\s*(approved|changes_required)\s*$/im.exec(section);
  return match?.[1] as "approved" | "changes_required" | undefined;
}

const STRUCTURED_RESULT_MARKER = "<!-- devcrew-role-result -->";
const STRUCTURED_RESULT_BLOCK = /<!--\s*devcrew-role-result\s*-->\s*```json\s*\r?\n([\s\S]*?)\r?\n```/g;

function structuredOutputError(role: RoleResult["role"], reason: string): RoleOutputValidationError {
  return new RoleOutputValidationError(role, [`marked structured role result: ${reason}`]);
}

function asRecord(value: unknown, role: RoleResult["role"], field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw structuredOutputError(role, `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, role: RoleResult["role"], field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw structuredOutputError(role, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function asStringArray(value: unknown, role: RoleResult["role"], field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw structuredOutputError(role, `${field} must be an array of non-empty strings`);
  }
  return value.map((entry) => (entry as string).trim());
}

function asEvidence(value: unknown, role: RoleResult["role"]): StructuredRoleData["evidence"] {
  if (!Array.isArray(value)) {
    throw structuredOutputError(role, "evidence must be an array");
  }
  return value.map((entry, index) => {
    const evidence = asRecord(entry, role, `evidence[${index}]`);
    const command = asNonEmptyString(evidence.command, role, `evidence[${index}].command`);
    if (!Number.isInteger(evidence.exitCode)) {
      throw structuredOutputError(role, `evidence[${index}].exitCode must be an integer`);
    }
    if (evidence.output !== undefined && typeof evidence.output !== "string") {
      throw structuredOutputError(role, `evidence[${index}].output must be a string`);
    }
    return { command, exitCode: evidence.exitCode as number, output: evidence.output as string | undefined };
  });
}

function asQuestions(value: unknown, role: RoleResult["role"]): NonNullable<StructuredRoleData["questions"]> {
  if (!Array.isArray(value)) {
    throw structuredOutputError(role, "questions must be an array");
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const question = asRecord(entry, role, `questions[${index}]`);
    const id = asNonEmptyString(question.id, role, `questions[${index}].id`);
    if (ids.has(id)) {
      throw structuredOutputError(role, `questions[${index}].id must be unique`);
    }
    ids.add(id);
    const prompt = asNonEmptyString(question.prompt, role, `questions[${index}].prompt`);
    if (question.context !== undefined && typeof question.context !== "string") {
      throw structuredOutputError(role, `questions[${index}].context must be a string`);
    }
    return { id, prompt, context: question.context as string | undefined };
  });
}

function parseStructuredRoleData(
  role: Exclude<RoleResult["role"], "conductor">,
  phase: Phase,
  raw: unknown,
): StructuredRoleData {
  const value = asRecord(raw, role, "result");
  if (value.schemaVersion !== 1) {
    throw structuredOutputError(role, "schemaVersion must be 1");
  }
  if (value.role !== role) {
    throw structuredOutputError(role, `role must be ${role}`);
  }
  const data: StructuredRoleData = {
    schemaVersion: 1,
    role,
    summary: asNonEmptyString(value.summary, role, "summary"),
    risks: asStringArray(value.risks, role, "risks"),
    evidence: asEvidence(value.evidence, role),
  };
  if (role === "pm") {
    data.questions = asQuestions(value.questions, role);
  } else if (role === "architect") {
    data.decisions = asStringArray(value.decisions, role, "decisions");
    if (phase === "review") {
      if (value.reviewDecision !== "approved" && value.reviewDecision !== "changes_required") {
        throw structuredOutputError(role, "reviewDecision must be approved or changes_required");
      }
      data.reviewDecision = value.reviewDecision;
    }
  } else if (role === "implementer") {
    data.changedFiles = asStringArray(value.changedFiles, role, "changedFiles");
  } else {
    if (!Array.isArray(value.testCases)) {
      throw structuredOutputError(role, "testCases must be an array");
    }
    data.testCases = value.testCases.map((entry, index) => {
      const testCase = asRecord(entry, role, `testCases[${index}]`);
      const type = testCase.type;
      if (type !== "happy" && type !== "edge" && type !== "failure" && type !== "regression") {
        throw structuredOutputError(role, `testCases[${index}].type is invalid`);
      }
      return {
        id: asNonEmptyString(testCase.id, role, `testCases[${index}].id`),
        scenario: asNonEmptyString(testCase.scenario, role, `testCases[${index}].scenario`),
        type,
        expected: asNonEmptyString(testCase.expected, role, `testCases[${index}].expected`),
      };
    });
  }
  return data;
}

export function parseRoleResultOutput(
  role: Exclude<RoleResult["role"], "conductor">,
  phase: Phase,
  output: string,
): Pick<RoleResult, "format" | "markdown" | "structured" | "questions" | "reviewDecision"> {
  if (!output.includes(STRUCTURED_RESULT_MARKER)) {
    return {
      format: "legacy",
      markdown: output,
      questions: role === "pm" ? extractOpenQuestions(output) : undefined,
      reviewDecision: phase === "review" ? extractArchitectureReviewDecision(output) : undefined,
    };
  }
  const blocks = [...output.matchAll(STRUCTURED_RESULT_BLOCK)];
  if (blocks.length !== 1) {
    throw structuredOutputError(role, blocks.length === 0 ? "must use a JSON fenced block" : "must appear exactly once");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(blocks[0]?.[1] ?? "");
  } catch {
    throw structuredOutputError(role, "contains invalid JSON");
  }
  const structured = parseStructuredRoleData(role, phase, raw);
  return {
    format: "structured",
    markdown: output.slice(0, blocks[0]?.index).concat(output.slice((blocks[0]?.index ?? 0) + (blocks[0]?.[0].length ?? 0))).trim(),
    structured,
    questions: structured.questions?.map((question) => question.prompt),
    reviewDecision: structured.reviewDecision,
  };
}

export function renderRolePrompt(input: Omit<RoleRunInput, "backend" | "cwd">): string {
  const executionMode = input.executionMode ?? "plan";
  const answers = input.answers ?? [];
  const feedback = input.feedback ?? [];
  const priorArtifacts = input.priorArtifacts ?? {};
  const lines = [
    `Role: ${input.role}`,
    `Phase: ${input.phase}`,
    `Mode: ${input.mode}`,
    `Execution Mode: ${executionMode}`,
    `Request: ${input.request}`,
    `Artifact Path: ${input.artifactPath}`,
    "",
    "Project Standards:",
    input.standards,
  ];

  if (answers.length > 0) {
    lines.push("", "Requester Answers:", ...answers.map((answer, index) => `${index + 1}. ${answer}`));
  }

  if (feedback.length > 0) {
    lines.push("", "Rejection Feedback To Address:", ...feedback.map((entry) => `- ${entry}`));
  }

  const artifactEntries = Object.entries(priorArtifacts);
  if (artifactEntries.length > 0) {
    lines.push("", "Prior Artifacts:");
    for (const [name, content] of artifactEntries) {
      lines.push("", `### ${name}`, content.trim());
    }
  }

  const canApply = roleCanApply({ ...input, executionMode });
  const permissionInstruction = canApply
    ? input.role === "tester"
      ? "You may run validation commands needed for the approved scope and report exact evidence."
      : "You may modify repository files needed for the approved scope and report changed files."
    : "Do not modify repository files. Return only the Markdown document content for the artifact.";

  lines.push(
    "",
    "Instructions:",
    `Act as the DevCrew ${input.role} role and produce a complete, well-structured Markdown document for the ${input.phase} phase.`,
    "Keep scope aligned with the approved gates and the selected DevCrew execution policy.",
    permissionInstruction,
    "",
    "Return this protocol block first:",
    STRUCTURED_RESULT_MARKER,
    "```json",
    `{\"schemaVersion\":1,\"role\":\"${input.role}\",\"summary\":\"...\",\"risks\":[],\"evidence\":[]}`,
    "```",
    "Then return the required Markdown H2 sections. Do not include a second marked result block.",
    "",
    "Required Sections:",
    ...roleGuidance(input.role),
  );

  if (input.phase === "review") {
    lines.push(
      "",
      "Architecture Review Decision:",
      "Add an exact H2 `## Review Decision` section containing exactly `Decision: approved` or `Decision: changes_required`.",
      "Use `changes_required` for any mismatch with the approved architecture; summarize the blocking mismatch in that section.",
    );
  }

  return lines.join("\n");
}

function titleForPhase(phase: Phase): string {
  return {
    requirements: "Requirements",
    architecture: "Architecture",
    implementation: "Implementation Plan",
    execution: "Implementation Review",
    review: "Architecture Review",
    testing: "Test Report",
    acceptance: "Acceptance",
    complete: "Acceptance",
  }[phase];
}

// --- Host SDK contracts -----------------------------------------------------
// These types pin the published surface of the optional host SDKs so the
// adapter logic is type-checked even though the packages are not installed.
// Verified against @openai/codex-sdk 0.144.5 (sdk/typescript/src/threadOptions.ts
// and thread.ts) and @anthropic-ai/claude-agent-sdk (Agent SDK TypeScript
// reference). Update these when the upstream contracts change.

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalMode = "never" | "on-request" | "on-failure" | "untrusted";

export interface CodexThreadOptions {
  model?: string;
  sandboxMode?: CodexSandboxMode;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  approvalPolicy?: CodexApprovalMode;
  networkAccessEnabled?: boolean;
}

export interface CodexTurn {
  finalResponse?: unknown;
  items?: unknown[];
  usage?: unknown;
}

interface CodexThread {
  run: (prompt: string, options?: Record<string, unknown>) => Promise<CodexTurn>;
}

interface CodexClient {
  startThread: (options?: CodexThreadOptions) => CodexThread;
}

interface CodexClientOptions {
  codexPathOverride?: string;
}

type CodexConstructor = new (options?: CodexClientOptions) => CodexClient;

export type ClaudePermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "plan";

export interface ClaudeQueryOptions {
  cwd?: string;
  permissionMode?: ClaudePermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  allowDangerouslySkipPermissions?: boolean;
}

export type ClaudeResultSubtype = "success" | "error_max_turns" | "error_during_execution";

export interface ClaudeResultMessage {
  type: "result";
  subtype?: ClaudeResultSubtype;
  result?: unknown;
  is_error?: boolean;
}

export interface ClaudeMessage {
  type?: string;
  subtype?: string;
  result?: unknown;
  is_error?: boolean;
}

type ClaudeQueryFn = (input: {
  prompt: string;
  options?: ClaudeQueryOptions;
}) => AsyncIterable<ClaudeMessage>;

export type ModuleLoader = (specifier: string) => Promise<Record<string, unknown>>;

export const HOST_SDK_PACKAGES = {
  codex: "@openai/codex-sdk",
  claude: "@anthropic-ai/claude-agent-sdk",
} as const satisfies Record<Exclude<BackendName, "local">, string>;

export interface HostSdkResolution {
  backend: BackendName;
  packageName: string;
  available: boolean;
  error?: string;
}

// Dynamic import with a non-literal specifier so the optional host SDKs do not
// need to be installed (or type-resolved) for DevCrew to build and run.
const importOptional: ModuleLoader = async (specifier: string) => {
  const dynamicSpecifier: string = specifier;
  return (await import(dynamicSpecifier)) as Record<string, unknown>;
};

function sdkPackageName(backend: BackendName): string {
  return backend === "local" ? "local" : HOST_SDK_PACKAGES[backend];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sdkResolutionHint(backend: BackendName, reason: string): string {
  const packageName = sdkPackageName(backend);
  if (backend === "local") {
    return reason;
  }
  return `${reason}. DevCrew apply mode requires ${packageName} to be resolvable from the ${DEVCREW_NPM_PACKAGE} package. Reinstall DevCrew with optional dependencies enabled, for example: npm install -g ${DEVCREW_NPM_PACKAGE} --include=optional`;
}

export async function checkHostSdkResolution(
  backend: BackendName,
  deps: RunRoleDeps = {},
): Promise<HostSdkResolution> {
  const packageName = sdkPackageName(backend);
  if (backend === "local") {
    return { backend, packageName, available: true };
  }
  const loadModule = deps.loadModule ?? importOptional;
  try {
    await loadModule(packageName);
    return { backend, packageName, available: true };
  } catch (error) {
    return { backend, packageName, available: false, error: errorMessage(error) };
  }
}

// --- Pure, testable contract helpers ---------------------------------------

export function buildCodexThreadOptions(
  cwd: string,
  sandboxMode: CodexSandboxMode = "read-only",
): CodexThreadOptions {
  return { workingDirectory: cwd, skipGitRepoCheck: true, sandboxMode };
}

export function extractCodexText(turn: CodexTurn | undefined): string {
  const text = typeof turn?.finalResponse === "string" ? turn.finalResponse.trim() : "";
  if (!text) {
    throw new Error("Codex SDK returned an empty finalResponse");
  }
  return text;
}

export function buildClaudeOptions(
  cwd: string,
  permissionMode: ClaudePermissionMode = "plan",
  allowedTools: string[] = ["Read", "Grep", "Glob"],
): ClaudeQueryOptions {
  // Read-only planning mode keeps roles from modifying the repository.
  return { cwd, permissionMode, allowedTools };
}

export function extractClaudeResult(message: ClaudeResultMessage | undefined): string {
  if (!message) {
    throw new Error("Claude Agent SDK did not return a result message");
  }
  if (message.is_error || (message.subtype && message.subtype !== "success")) {
    throw new Error(`Claude Agent SDK ended with subtype "${message.subtype ?? "unknown"}"`);
  }
  const text = typeof message.result === "string" ? message.result.trim() : "";
  if (!text) {
    throw new Error("Claude Agent SDK returned an empty result");
  }
  return text;
}

function isApplyPhase(input: Pick<RoleRunInput, "executionMode" | "phase">): boolean {
  return input.executionMode === "apply" && (input.phase === "execution" || input.phase === "testing");
}

function effectiveExecutionPolicy(input: Pick<RoleRunInput, "executionPolicy">): ExecutionPolicy {
  return input.executionPolicy ?? "interactive-host";
}

function roleCanApply(input: Pick<RoleRunInput, "executionMode" | "executionPolicy" | "phase">): boolean {
  return isApplyPhase(input) && effectiveExecutionPolicy(input) !== "interactive-host";
}

function codexOptionsForRole(input: RoleRunInput): CodexThreadOptions {
  if (!roleCanApply(input)) {
    return buildCodexThreadOptions(input.cwd);
  }
  const executionPolicy = effectiveExecutionPolicy(input);
  return {
    ...buildCodexThreadOptions(input.cwd, "workspace-write"),
    approvalPolicy: executionPolicy === "headless-unattended" ? "never" : "on-request",
    networkAccessEnabled: false,
  };
}

function claudeOptionsForRole(input: RoleRunInput): ClaudeQueryOptions {
  if (!roleCanApply(input)) {
    return buildClaudeOptions(input.cwd);
  }
  if (effectiveExecutionPolicy(input) === "headless-unattended") {
    return {
      cwd: input.cwd,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    };
  }
  const allowedTools =
    input.role === "implementer" ? ["Read", "Grep", "Glob", "Edit", "Write"] : ["Read", "Grep", "Glob"];
  return buildClaudeOptions(input.cwd, "dontAsk", allowedTools);
}

function resolveHostCodexExecutable(): string | undefined {
  const explicitPath = process.env.DEVCREW_CODEX_PATH?.trim();
  if (explicitPath) {
    return explicitPath;
  }

  const pathValue = process.env.PATH ?? Object.entries(process.env)
    .find(([key]) => key.toLowerCase() === "path")?.[1];
  if (!pathValue) {
    return undefined;
  }

  const executableNames = process.platform === "win32"
    ? ["codex.exe", "codex.cmd", "codex.bat", "codex"]
    : ["codex"];
  for (const entry of pathValue.split(delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, "");
    if (!directory) {
      continue;
    }
    for (const executableName of executableNames) {
      const candidate = join(directory, executableName);
      try {
        accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        const normalizedCandidate = candidate.split(sep).join("/");
        const normalizedRealPath = realpathSync(candidate).split(sep).join("/");
        if (
          normalizedCandidate.includes("/node_modules/.bin/")
          || normalizedRealPath.includes("/node_modules/@openai/codex/")
        ) {
          continue;
        }
        return candidate;
      } catch {
        // Keep searching PATH; the SDK's packaged runtime remains the fallback.
      }
    }
  }
  return undefined;
}

async function runWithCodex(input: RoleRunInput, prompt: string, loadModule: ModuleLoader): Promise<string> {
  const mod = await loadModule(HOST_SDK_PACKAGES.codex);
  const CodexClass = mod.Codex as CodexConstructor;
  const codexPathOverride = resolveHostCodexExecutable();
  const codex = new CodexClass(codexPathOverride ? { codexPathOverride } : undefined);
  const thread = codex.startThread(codexOptionsForRole(input));
  const turn = await thread.run(prompt);
  return extractCodexText(turn);
}

async function runWithClaude(input: RoleRunInput, prompt: string, loadModule: ModuleLoader): Promise<string> {
  const mod = await loadModule(HOST_SDK_PACKAGES.claude);
  const query = mod.query as ClaudeQueryFn;
  let resultMessage: ClaudeResultMessage | undefined;
  for await (const message of query({ prompt, options: claudeOptionsForRole(input) })) {
    if (message?.type === "result") {
      resultMessage = message as ClaudeResultMessage;
    }
  }
  return extractClaudeResult(resultMessage);
}

function fallbackResult(
  role: RoleResult["role"],
  backend: BackendName,
  title: string,
  summary: string,
): RoleResult {
  return {
    role,
    backend,
    summary,
    markdown: `# ${title}\n\n${summary}\n`,
    usedFallback: true,
    format: "legacy",
  };
}

function shouldFailOnSdkError(input: RoleRunInput): boolean {
  return input.executionMode === "apply" && input.backend !== "local";
}

export interface RunRoleDeps {
  loadModule?: ModuleLoader;
}

export async function runRole(input: RoleRunInput, deps: RunRoleDeps = {}): Promise<RoleResult> {
  if (isApplyPhase(input) && effectiveExecutionPolicy(input) === "interactive-host") {
    throw new Error("DevCrew interactive-host execution must be performed by the host, not a nested SDK");
  }
  const loadModule = deps.loadModule ?? importOptional;
  const title = titleForPhase(input.phase);
  const prompt = renderRolePrompt(input);

  if (input.backend === "local") {
    return fallbackResult(
      input.role,
      input.backend,
      title,
      `${input.role} prepared a deterministic ${title} because the local backend does not call an external SDK.`,
    );
  }

  try {
    const markdown =
      input.backend === "codex"
        ? await runWithCodex(input, prompt, loadModule)
        : await runWithClaude(input, prompt, loadModule);
    const parsed = parseRoleResultOutput(input.role, input.phase, markdown);
    assertRoleSections(input.role, parsed.markdown);
    const reviewDecision = parsed.reviewDecision;
    if (input.phase === "review" && !reviewDecision) {
      throw new RoleOutputValidationError(input.role, ["Review Decision"]);
    }
    return {
      role: input.role,
      backend: input.backend,
      summary: parsed.structured?.summary ?? `${input.role} produced ${title} using the ${input.backend} SDK.`,
      markdown: parsed.markdown,
      usedFallback: false,
      format: parsed.format,
      structured: parsed.structured,
      questions: parsed.questions,
      reviewDecision,
    };
  } catch (error) {
    const reason = errorMessage(error);
    if (shouldFailOnSdkError(input)) {
      if (error instanceof RoleOutputValidationError) {
        throw new Error(`DevCrew apply mode rejected invalid ${input.role} SDK output: ${reason}`);
      }
      throw new Error(
        `Cannot run DevCrew apply mode with unavailable ${input.backend} SDK: ${sdkResolutionHint(input.backend, reason)}`,
      );
    }
    const fallbackReason = error instanceof RoleOutputValidationError
      ? `the ${input.backend} SDK output failed validation: ${reason}`
      : `the ${input.backend} SDK was unavailable: ${reason}`;
    return fallbackResult(
      input.role,
      input.backend,
      title,
      `${input.role} prepared a deterministic ${title} fallback because ${fallbackReason}`,
    );
  }
}
