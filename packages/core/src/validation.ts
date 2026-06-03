import {
  ARTIFACTS,
  BACKENDS,
  GATES,
  HOSTS,
  WORKFLOW_MODES,
  type ArtifactName,
  type BackendName,
  type GateName,
  type Host,
  type WorkflowMode,
} from "./types.js";

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function oneOf<T extends readonly string[]>(value: unknown, field: string, values: T): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${field} must be one of: ${values.join(", ")}`);
  }
  return value as T[number];
}

export function parseWorkflowMode(value: unknown): WorkflowMode {
  return oneOf(value, "mode", WORKFLOW_MODES);
}

export function parseHost(value: unknown): Host {
  return oneOf(value, "host", HOSTS);
}

export function parseBackend(value: unknown): BackendName {
  return oneOf(value, "backend", BACKENDS);
}

export function parseGate(value: unknown): GateName {
  return oneOf(value, "gate", GATES);
}

export function parseArtifactName(value: unknown): ArtifactName {
  return oneOf(value, "name", ARTIFACTS);
}

export function parseCwd(value: unknown): string {
  return assertString(value, "cwd");
}

export function parseRunId(value: unknown): string {
  return assertString(value, "runId");
}

export function parseRequest(value: unknown): string {
  return assertString(value, "request");
}

export function parseOptionalNote(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return assertString(value, "note");
}

export function parseFeedback(value: unknown): string {
  return assertString(value, "feedback");
}

export function parseAnswer(value: unknown): string {
  return assertString(value, "answer");
}
