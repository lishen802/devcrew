import type { BackendName, Host, Phase, RoleResult, WorkflowMode } from "../../core/src/index.js";

export interface BackendResolutionInput {
  host: Host;
  configuredBackend?: BackendName | "host-preferred";
}

export interface RoleRunInput {
  backend: BackendName;
  role: RoleResult["role"];
  phase: Phase;
  request: string;
  mode: WorkflowMode;
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

export function renderRolePrompt(input: Omit<RoleRunInput, "backend" | "cwd">): string {
  const answers = input.answers ?? [];
  const feedback = input.feedback ?? [];
  const priorArtifacts = input.priorArtifacts ?? {};
  const lines = [
    `Role: ${input.role}`,
    `Phase: ${input.phase}`,
    `Mode: ${input.mode}`,
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

  lines.push(
    "",
    "Instructions:",
    `Act as the DevCrew ${input.role} role and produce a complete, well-structured Markdown document for the ${input.phase} phase.`,
    "Keep scope aligned with the approved gates and inherited host permissions.",
    "Do not modify repository files. Return only the Markdown document content for the artifact.",
  );

  return lines.join("\n");
}

function titleForPhase(phase: Phase): string {
  return {
    requirements: "Requirements",
    architecture: "Architecture",
    implementation: "Implementation Plan",
    testing: "Test Report",
    acceptance: "Acceptance",
    complete: "Acceptance",
  }[phase];
}

// --- Host SDK contracts -----------------------------------------------------
// These types pin the published surface of the optional host SDKs so the
// adapter logic is type-checked even though the packages are not installed.
// Verified against @openai/codex-sdk 0.136.0 (sdk/typescript/src/threadOptions.ts
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

type CodexConstructor = new () => CodexClient;

export type ClaudePermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

export interface ClaudeQueryOptions {
  cwd?: string;
  permissionMode?: ClaudePermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
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

// Dynamic import with a non-literal specifier so the optional host SDKs do not
// need to be installed (or type-resolved) for DevCrew to build and run.
const importOptional: ModuleLoader = async (specifier: string) => {
  const dynamicSpecifier: string = specifier;
  return (await import(dynamicSpecifier)) as Record<string, unknown>;
};

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

export function buildClaudeOptions(cwd: string): ClaudeQueryOptions {
  // Read-only planning mode keeps roles from modifying the repository.
  return { cwd, permissionMode: "plan", allowedTools: ["Read", "Grep", "Glob"] };
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

async function runWithCodex(prompt: string, cwd: string, loadModule: ModuleLoader): Promise<string> {
  const mod = await loadModule("@openai/codex-sdk");
  const CodexClass = mod.Codex as CodexConstructor;
  const codex = new CodexClass();
  const thread = codex.startThread(buildCodexThreadOptions(cwd));
  const turn = await thread.run(prompt);
  return extractCodexText(turn);
}

async function runWithClaude(prompt: string, cwd: string, loadModule: ModuleLoader): Promise<string> {
  const mod = await loadModule("@anthropic-ai/claude-agent-sdk");
  const query = mod.query as ClaudeQueryFn;
  let resultMessage: ClaudeResultMessage | undefined;
  for await (const message of query({ prompt, options: buildClaudeOptions(cwd) })) {
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
  };
}

export interface RunRoleDeps {
  loadModule?: ModuleLoader;
}

export async function runRole(input: RoleRunInput, deps: RunRoleDeps = {}): Promise<RoleResult> {
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
        ? await runWithCodex(prompt, input.cwd, loadModule)
        : await runWithClaude(prompt, input.cwd, loadModule);
    return {
      role: input.role,
      backend: input.backend,
      summary: `${input.role} produced ${title} using the ${input.backend} SDK.`,
      markdown,
      usedFallback: false,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fallbackResult(
      input.role,
      input.backend,
      title,
      `${input.role} prepared a deterministic ${title} fallback because the ${input.backend} SDK was unavailable: ${reason}`,
    );
  }
}
