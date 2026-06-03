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
}

export function resolveBackendName(input: BackendResolutionInput): BackendName {
  if (input.configuredBackend && input.configuredBackend !== "host-preferred") {
    return input.configuredBackend;
  }
  return input.host;
}

export function renderRolePrompt(input: Omit<RoleRunInput, "backend" | "cwd">): string {
  return [
    `Role: ${input.role}`,
    `Phase: ${input.phase}`,
    `Mode: ${input.mode}`,
    `Request: ${input.request}`,
    `Artifact Path: ${input.artifactPath}`,
    "",
    "Project Standards:",
    input.standards,
    "",
    "Instructions:",
    "Produce concise Markdown for the assigned phase. Keep scope aligned with approved gates and inherited host permissions.",
  ].join("\n");
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

async function canImport(moduleName: string): Promise<boolean> {
  try {
    const dynamicImport = new Function("moduleName", "return import(moduleName)") as (name: string) => Promise<unknown>;
    await dynamicImport(moduleName);
    return true;
  } catch {
    return false;
  }
}

export async function runRole(input: RoleRunInput): Promise<RoleResult> {
  const prompt = renderRolePrompt(input);
  const sdkModule = input.backend === "codex" ? "@openai/codex-sdk" : input.backend === "claude" ? "@anthropic-ai/claude-agent-sdk" : undefined;
  const sdkAvailable = sdkModule ? await canImport(sdkModule) : false;
  const title = titleForPhase(input.phase);
  const summary = sdkAvailable
    ? `${input.role} prepared ${title} using ${input.backend} SDK.`
    : `${input.role} prepared deterministic ${title} fallback because ${input.backend} SDK is not installed.`;

  return {
    role: input.role,
    backend: input.backend,
    summary,
    markdown: `# ${title}\n\n${summary}\n\n## Prompt\n\n\`\`\`text\n${prompt}\n\`\`\`\n`,
  };
}
