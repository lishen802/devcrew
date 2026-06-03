import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  generateClaudePlugin,
  generateCodexPlugin,
  initProject,
} from "../packages/plugins/src/index.js";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "devcrew-plugins-"));
}

test("generateCodexPlugin writes a valid Codex plugin manifest and entry skill", async () => {
  const root = await tempProject();
  const plugin = await generateCodexPlugin(root);

  const manifest = JSON.parse(await readFile(join(plugin.path, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "devcrew");
  assert.equal(manifest.skills, "./skills/");

  const skill = await readFile(join(plugin.path, "skills", "devcrew", "SKILL.md"), "utf8");
  assert.match(skill, /devcrew_start/);
  assert.match(skill, /devcrew_approve/);
});

test("generateClaudePlugin writes a Claude plugin with agents and MCP config", async () => {
  const root = await tempProject();
  const plugin = await generateClaudePlugin(root);

  const manifest = JSON.parse(await readFile(join(plugin.path, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "devcrew");

  const agent = await readFile(join(plugin.path, "agents", "architect.md"), "utf8");
  assert.match(agent, /name: architect/);
  assert.match(agent, /technical architecture/);

  const mcp = JSON.parse(await readFile(join(plugin.path, ".mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.devcrew.command, "devcrew");
});

test("initProject creates config, standards placeholder, docs directory, and both plugin bundles", async () => {
  const root = await tempProject();
  const result = await initProject(root);

  await stat(join(root, ".devcrew", "config.json"));
  await stat(join(root, ".devcrew", "standards.md"));
  await stat(join(root, "docs", "devcrew"));
  await stat(join(result.codex.path, ".codex-plugin", "plugin.json"));
  await stat(join(result.claude.path, ".claude-plugin", "plugin.json"));
});
