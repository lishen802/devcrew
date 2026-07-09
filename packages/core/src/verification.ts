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

export async function readPackageJson(cwd: string): Promise<{ scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | undefined> {
  const raw = await readIfExists(join(cwd, "package.json"));
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  } catch {
    return undefined;
  }
}

async function packageLintCommands(cwd: string): Promise<string[]> {
  const parsed = await readPackageJson(cwd);
  if (!parsed) {
    return [];
  }
  const scripts = parsed.scripts ?? {};
  const commands: string[] = [];
  if (scripts.typecheck) {
    commands.push("npm run typecheck");
  }
  if (scripts.lint) {
    commands.push("npm run lint");
  }
  if (scripts["format:check"]) {
    commands.push("npm run format:check");
  }
  return commands;
}

export async function discoverLintCommands(cwd: string): Promise<string[]> {
  const packageCommands = await packageLintCommands(cwd);
  if (packageCommands.length > 0) {
    return packageCommands;
  }
  const pyproject = await readIfExists(join(cwd, "pyproject.toml"));
  if (pyproject) {
    const commands: string[] = [];
    if (pyproject.includes("ruff")) {
      commands.push("ruff check .");
    }
    if (pyproject.includes("black")) {
      commands.push("black --check .");
    }
    if (commands.length > 0) {
      return commands;
    }
  }
  if (await exists(join(cwd, "go.mod"))) {
    return ["files=$(gofmt -l .) && test -z \"$files\" || { printf '%s\\n' \"$files\"; exit 1; }", "go vet ./..."];
  }
  if (await exists(join(cwd, "Cargo.toml"))) {
    return ["cargo fmt --check", "cargo clippy"];
  }
  return [];
}

async function packageCoverageCommands(cwd: string): Promise<string[]> {
  const parsed = await readPackageJson(cwd);
  if (!parsed) {
    return [];
  }
  const scripts = parsed.scripts ?? {};
  if (scripts.coverage) {
    return ["npm run coverage"];
  }
  const deps = { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };
  const testScript = scripts.test ?? "";
  const usesCoverageRunner = "jest" in deps || "vitest" in deps || testScript.includes("jest") || testScript.includes("vitest");
  if (scripts.test && usesCoverageRunner) {
    return ["npm test -- --coverage"];
  }
  return [];
}

export async function discoverCoverageCommands(cwd: string): Promise<string[]> {
  const packageCommands = await packageCoverageCommands(cwd);
  if (packageCommands.length > 0) {
    return packageCommands;
  }
  const pyproject = await readIfExists(join(cwd, "pyproject.toml"));
  if (pyproject && (pyproject.includes("[tool.pytest") || pyproject.includes("pytest"))) {
    return ["python -m pytest --cov"];
  }
  if (await exists(join(cwd, "go.mod"))) {
    return ["go test -cover ./..."];
  }
  return [];
}
