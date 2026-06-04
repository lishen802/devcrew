import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    await access(path);
    return readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function packageVerifyCommands(cwd: string): Promise<string[]> {
  const raw = await readIfExists(join(cwd, "package.json"));
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = parsed.scripts ?? {};
    if (scripts.validate) {
      return ["npm run validate"];
    }
    if (scripts.test) {
      return ["npm test"];
    }
    const commands: string[] = [];
    if (scripts.typecheck) {
      commands.push("npm run typecheck");
    }
    if (scripts.lint) {
      commands.push("npm run lint");
    }
    return commands;
  } catch {
    return [];
  }
}

async function pythonVerifyCommands(cwd: string): Promise<string[]> {
  const pyproject = await readIfExists(join(cwd, "pyproject.toml"));
  if (!pyproject) {
    return [];
  }
  if (pyproject.includes("[tool.pytest") || pyproject.includes("pytest")) {
    return ["python -m pytest"];
  }
  return [];
}

export async function discoverVerifyCommands(cwd: string): Promise<string[]> {
  const packageCommands = await packageVerifyCommands(cwd);
  if (packageCommands.length > 0) {
    return packageCommands;
  }
  if (await exists(join(cwd, "go.mod"))) {
    return ["go test ./..."];
  }
  if (await exists(join(cwd, "Cargo.toml"))) {
    return ["cargo test"];
  }
  return pythonVerifyCommands(cwd);
}
