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

// Dynamic import with a non-literal specifier so the optional host SDKs do not
// need to be installed (or type-resolved) for DevCrew to build and run.
async function importOptional(specifier: string): Promise<Record<string, unknown>> {
  const dynamicSpecifier: string = specifier;
  return (await import(dynamicSpecifier)) as Record<string, unknown>;
}

async function runWithCodex(prompt: string, cwd: string): Promise<string> {
  const mod = await importOptional("@openai/codex-sdk");
  const CodexClass = mod.Codex as new () => {
    startThread: (options?: Record<string, unknown>) => {
      run: (prompt: string) => Promise<{ finalResponse?: unknown }>;
    };
  };
  const codex = new CodexClass();
  const thread = codex.startThread({ workingDirectory: cwd, skipGitRepoCheck: true, sandboxMode: "read-only" });
  const turn = await thread.run(prompt);
  const text = typeof turn?.finalResponse === "string" ? turn.finalResponse.trim() : "";
  if (!text) {
    throw new Error("Codex SDK returned an empty response");
  }
  return text;
}

async function runWithClaude(prompt: string, cwd: string): Promise<string> {
  const mod = await importOptional("@anthropic-ai/claude-agent-sdk");
  const query = mod.query as (input: {
    prompt: string;
    options?: Record<string, unknown>;
  }) => AsyncIterable<{ type?: string; result?: unknown }>;
  let finalText = "";
  for await (const message of query({
    prompt,
    // Read-only planning mode keeps roles from modifying the repository.
    options: { cwd, permissionMode: "plan", allowedTools: ["Read", "Grep", "Glob"] },
  })) {
    if (message?.type === "result" && typeof message.result === "string") {
      finalText = message.result;
    }
  }
  const text = finalText.trim();
  if (!text) {
    throw new Error("Claude Agent SDK returned an empty response");
  }
  return text;
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

export async function runRole(input: RoleRunInput): Promise<RoleResult> {
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
      input.backend === "codex" ? await runWithCodex(prompt, input.cwd) : await runWithClaude(prompt, input.cwd);
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
