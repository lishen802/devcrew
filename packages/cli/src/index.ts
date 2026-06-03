#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { initProject } from "../../plugins/src/index.js";
import { runStdioServer } from "../../service/src/index.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function usage(): string {
  return `DevCrew 0.1.0\n\nUsage:\n  devcrew init [cwd]\n  devcrew serve --stdio\n  devcrew doctor [cwd]\n  devcrew validate [cwd]\n`;
}

async function doctor(cwd: string): Promise<void> {
  const config = resolve(cwd, ".devcrew", "config.json");
  const codex = resolve(cwd, "plugins", "devcrew-codex", ".codex-plugin", "plugin.json");
  const claude = resolve(cwd, "plugins", "devcrew-claude", ".claude-plugin", "plugin.json");
  console.log(`Node: ${process.version}`);
  console.log(`Config: ${(await exists(config)) ? "ok" : "missing"}`);
  console.log(`Codex plugin: ${(await exists(codex)) ? "ok" : "missing"}`);
  console.log(`Claude plugin: ${(await exists(claude)) ? "ok" : "missing"}`);
}

async function validate(cwd: string): Promise<void> {
  const configPath = resolve(cwd, ".devcrew", "config.json");
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown; workflow?: unknown };
  if (parsed.version !== 1 || typeof parsed.workflow !== "object") {
    throw new Error(`${configPath} is not a valid DevCrew config`);
  }
  console.log(`Validated ${configPath}`);
}

async function main(argv: string[]): Promise<void> {
  const [command, maybeCwd, ...rest] = argv;
  const cwd = resolve(maybeCwd && !maybeCwd.startsWith("--") ? maybeCwd : process.cwd());

  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  if (command === "init") {
    const result = await initProject(cwd);
    console.log(`Initialized DevCrew in ${cwd}`);
    console.log(`Codex plugin: ${result.codex.path}`);
    console.log(`Claude plugin: ${result.claude.path}`);
    return;
  }

  if (command === "serve") {
    if (!argv.includes("--stdio") && rest.length > 0) {
      throw new Error("Only stdio transport is supported in v0.1.0");
    }
    runStdioServer();
    return;
  }

  if (command === "doctor") {
    await doctor(cwd);
    return;
  }

  if (command === "validate") {
    await validate(cwd);
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
