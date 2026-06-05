import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { standardsPath } from "./paths.js";
import type { StandardsDiscovery } from "./types.js";
import { readPackageJson } from "./verification.js";

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    await access(path);
    return readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function section(path: string, content: string): string {
  return `## ${path}\n\n${content.trim()}\n`;
}

async function packageJsonSummary(cwd: string): Promise<string | undefined> {
  const parsed = await readPackageJson(cwd);
  if (!parsed) {
    return undefined;
  }
  const scripts = Object.keys(parsed.scripts ?? {});
  if (scripts.length === 0) {
    return "package.json scripts: none";
  }
  return `package.json scripts: ${scripts.join(", ")}`;
}

export async function discoverStandards(cwd: string): Promise<StandardsDiscovery> {
  const candidates = [
    standardsPath(cwd),
    join(cwd, "AGENTS.md"),
    join(cwd, "CLAUDE.md"),
    join(cwd, "README.md"),
    join(cwd, "README"),
    join(cwd, "pyproject.toml"),
    join(cwd, "go.mod"),
    join(cwd, "Cargo.toml"),
  ];
  const sources: string[] = [];
  const sections: string[] = [];

  for (const candidate of candidates) {
    const content = await readIfExists(candidate);
    if (content?.trim()) {
      sources.push(candidate);
      sections.push(section(candidate, content));
    }
  }

  const packageSummary = await packageJsonSummary(cwd);
  if (packageSummary) {
    const packagePath = join(cwd, "package.json");
    sources.push(packagePath);
    sections.push(section(packagePath, packageSummary));
  }

  if (sections.length === 0) {
    sections.push("No project standards were discovered. Follow the current repository style and ask before broad refactors.\n");
  }

  return {
    sources,
    combined: sections.join("\n"),
  };
}
