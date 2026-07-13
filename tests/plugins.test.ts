import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { DEVCREW_NPM_PACKAGE, DEVCREW_VERSION } from "../packages/core/src/index.js";
import {
  generateCodexMarketplace,
  generateClaudePlugin,
  generateCodexPlugin,
  initProject,
} from "../packages/plugins/src/index.js";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "devcrew-plugins-"));
}

function assertVersionLockedMcpServer(mcp: {
  mcpServers: { devcrew: { command: string; args: string[]; env: Record<string, string> } };
}, host: "codex" | "claude"): void {
  const server = mcp.mcpServers.devcrew;
  assert.equal(server.command, "npm");
  assert.deepEqual(server.args.slice(0, 5), [
    "exec",
    "--silent",
    "--yes",
    `--package=${DEVCREW_NPM_PACKAGE}@${DEVCREW_VERSION}`,
    "--",
  ]);
  assert.equal(server.args[5], "node");
  assert.equal(server.args[6], "-e");
  assert.match(server.args[7], /dist\/packages\/cli\/src\/index\.js/);
  assert.deepEqual(server.args.slice(8), ["--", "serve", "--stdio"]);
  assert.deepEqual(server.env, { DEVCREW_HOST: host });
}

test("generateCodexPlugin writes a valid Codex plugin manifest and entry skill", async () => {
  const root = await tempProject();
  const plugin = await generateCodexPlugin(root);

  const manifest = JSON.parse(await readFile(join(plugin.path, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "devcrew");
  assert.equal(manifest.version, DEVCREW_VERSION);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.interface.displayName, "DevCrew");
  assert.equal(manifest.interface.logo, "./assets/logo.png");
  assert.equal(manifest.interface.composerIcon, "./assets/composer-icon.png");

  const skill = await readFile(join(plugin.path, "skills", "devcrew", "SKILL.md"), "utf8");
  assert.match(skill, /devcrew_start/);
  assert.match(skill, /devcrew_approve/);
  assert.match(skill, /devcrew_complete_execution/);
  assert.match(skill, /devcrew_waive_verification/);
  assert.match(skill, /headless-restricted/);
  assert.doesNotMatch(skill, /inherits host sandbox, approval, and tool permissions/i);
  await stat(join(plugin.path, "assets", "logo.png"));
  await stat(join(plugin.path, "assets", "composer-icon.png"));
  await assert.rejects(() => stat(join(plugin.path, "agents")));

  const mcp = JSON.parse(await readFile(join(plugin.path, ".mcp.json"), "utf8"));
  assertVersionLockedMcpServer(mcp, "codex");
});

test("checked-in Codex plugin locks MCP server to the published npm version", async () => {
  const mcp = JSON.parse(await readFile(join(process.cwd(), "plugins", "devcrew-codex", ".mcp.json"), "utf8"));

  assertVersionLockedMcpServer(mcp, "codex");
});

test("checked-in Codex plugin matches the shared generator", async () => {
  const root = await tempProject();
  const generated = await generateCodexPlugin(root);
  const checkedIn = join(process.cwd(), "plugins", "devcrew-codex");
  const relativeFiles = [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "skills/devcrew/SKILL.md",
    "assets/composer-icon.png",
    "assets/logo.png",
  ];

  for (const file of relativeFiles) {
    assert.deepEqual(
      await readFile(join(checkedIn, file)),
      await readFile(join(generated.path, file)),
      `${file} drifted from generateCodexPlugin`,
    );
  }
});

test("generateCodexMarketplace writes a repo marketplace entry for plugin installation", async () => {
  const root = await tempProject();
  await generateCodexPlugin(root);
  const marketplace = await generateCodexMarketplace(root);

  const content = JSON.parse(await readFile(marketplace.path, "utf8"));
  assert.equal(content.name, "devcrew");
  assert.equal(content.interface.displayName, "DevCrew");
  assert.equal(content.plugins[0].name, "devcrew");
  assert.equal(content.plugins[0].source.path, "./plugins/devcrew-codex");
  assert.equal(content.plugins[0].policy.installation, "AVAILABLE");
});

test("generateClaudePlugin omits inactive agent files and writes MCP config", async () => {
  const root = await tempProject();
  const plugin = await generateClaudePlugin(root);

  const manifest = JSON.parse(await readFile(join(plugin.path, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "devcrew");
  assert.equal(manifest.version, DEVCREW_VERSION);

  await assert.rejects(() => stat(join(plugin.path, "agents")));

  const mcp = JSON.parse(await readFile(join(plugin.path, ".mcp.json"), "utf8"));
  assertVersionLockedMcpServer(mcp, "claude");
});

test("initProject creates config, standards placeholder, docs directory, and both plugin bundles", async () => {
  const root = await tempProject();
  const result = await initProject(root);

  await stat(join(root, ".devcrew", "config.json"));
  await stat(join(root, ".devcrew", "standards.md"));
  await stat(join(root, "docs", "devcrew"));
  await stat(join(result.codex.path, ".codex-plugin", "plugin.json"));
  await stat(join(root, ".agents", "plugins", "marketplace.json"));
  await stat(join(result.claude.path, ".claude-plugin", "plugin.json"));
});
