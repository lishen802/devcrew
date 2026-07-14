import { access, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { configPath, ensureProjectDirectories } from "./paths.js";
import { BACKENDS, EXECUTION_MODES, GATES, type BackendName, type DevCrewConfig, type ExecutionMode, type GateName } from "./types.js";

export const DEFAULT_CONFIG: DevCrewConfig = {
  version: 1,
  defaultBackend: "host-preferred",
  executionMode: "plan",
  verifyCommands: [],
  lintCommands: [],
  coverageCommands: [],
  workflow: {
    gates: ["requirements", "architecture", "implementation", "implementation-review", "testing"],
    artifactDirectory: "docs/devcrew",
  },
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, field: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid .devcrew/config.json: ${field} must be an object`);
  }
  return value as JsonRecord;
}

function assertKnownKeys(value: JsonRecord, field: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`Invalid .devcrew/config.json: ${field} has unknown key ${key}`);
    }
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid .devcrew/config.json: ${field} must be a non-empty string`);
  }
  return value.trim();
}

function parseCommandList(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Invalid .devcrew/config.json: ${field} must be an array`);
  }
  return value.map((entry, index) => requiredString(entry, `${field}[${index}]`));
}

function parseGates(value: unknown): GateName[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid .devcrew/config.json: workflow.gates must be an array");
  }
  const gates: GateName[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || !GATES.includes(entry as GateName)) {
      throw new Error(`Invalid .devcrew/config.json: workflow.gates[${index}] must be a known gate, received ${String(entry)}`);
    }
    if (gates.includes(entry as GateName)) {
      throw new Error(`Invalid .devcrew/config.json: workflow.gates contains duplicate ${entry}`);
    }
    gates.push(entry as GateName);
  }
  return gates;
}

function parseArtifactDirectory(cwd: string, value: unknown): string {
  const artifactDirectory = requiredString(value, "workflow.artifactDirectory");
  if (isAbsolute(artifactDirectory)) {
    throw new Error("Invalid .devcrew/config.json: workflow.artifactDirectory must be relative to the repository");
  }
  const projectRoot = resolve(cwd);
  const target = resolve(projectRoot, artifactDirectory);
  const fromProject = relative(projectRoot, target);
  if (fromProject === ".." || fromProject.startsWith(`..${sep}`) || isAbsolute(fromProject)) {
    throw new Error("Invalid .devcrew/config.json: workflow.artifactDirectory must resolve inside the repository");
  }
  return artifactDirectory;
}

function parseConfig(cwd: string, value: unknown): DevCrewConfig {
  const parsed = asRecord(value, "root");
  assertKnownKeys(parsed, "root", ["version", "defaultBackend", "executionMode", "verifyCommands", "lintCommands", "coverageCommands", "workflow"]);
  if (parsed.version !== 1) {
    throw new Error("Unsupported .devcrew/config.json version");
  }
  if (typeof parsed.defaultBackend !== "string" || (parsed.defaultBackend !== "host-preferred" && !BACKENDS.includes(parsed.defaultBackend as BackendName))) {
    throw new Error("Invalid .devcrew/config.json: defaultBackend must be host-preferred, codex, claude, or local");
  }
  if (typeof parsed.executionMode !== "string" || !EXECUTION_MODES.includes(parsed.executionMode as ExecutionMode)) {
    throw new Error("Invalid .devcrew/config.json: executionMode must be plan or apply");
  }
  const workflow = asRecord(parsed.workflow, "workflow");
  assertKnownKeys(workflow, "workflow", ["gates", "artifactDirectory"]);
  return {
    version: 1,
    defaultBackend: parsed.defaultBackend as DevCrewConfig["defaultBackend"],
    executionMode: parsed.executionMode as ExecutionMode,
    verifyCommands: parseCommandList(parsed.verifyCommands, "verifyCommands"),
    lintCommands: parseCommandList(parsed.lintCommands, "lintCommands"),
    coverageCommands: parseCommandList(parsed.coverageCommands, "coverageCommands"),
    workflow: {
      gates: parseGates(workflow.gates),
      artifactDirectory: parseArtifactDirectory(cwd, workflow.artifactDirectory),
    },
  };
}

export async function ensureConfig(cwd: string): Promise<DevCrewConfig> {
  await ensureProjectDirectories(cwd);
  const path = configPath(cwd);
  if (!(await exists(path))) {
    await writeFile(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
    return DEFAULT_CONFIG;
  }
  return readConfig(cwd);
}

export async function readConfig(cwd: string): Promise<DevCrewConfig> {
  const raw = await readFile(configPath(cwd), "utf8");
  return parseConfig(cwd, JSON.parse(raw) as unknown);
}
