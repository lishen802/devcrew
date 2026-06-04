import { access, readFile, writeFile } from "node:fs/promises";

import { configPath, ensureProjectDirectories } from "./paths.js";
import type { DevCrewConfig } from "./types.js";

export const DEFAULT_CONFIG: DevCrewConfig = {
  version: 1,
  defaultBackend: "host-preferred",
  executionMode: "plan",
  verifyCommands: [],
  workflow: {
    gates: ["requirements", "architecture", "implementation", "testing"],
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
  const parsed = JSON.parse(raw) as DevCrewConfig;
  if (parsed.version !== 1) {
    throw new Error("Unsupported .devcrew/config.json version");
  }
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    executionMode: parsed.executionMode ?? "plan",
    verifyCommands: Array.isArray(parsed.verifyCommands) ? parsed.verifyCommands : [],
    workflow: {
      ...DEFAULT_CONFIG.workflow,
      ...parsed.workflow,
    },
  };
}
