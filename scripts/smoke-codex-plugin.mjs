#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultMarketplaceSource = "lishen802/devcrew";
const defaultMarketplaceRef = "main";
const jsonRpcTimeoutMs = 120_000;

function help() {
  return `DevCrew Codex plugin smoke test

Installs the DevCrew Codex plugin from a Codex marketplace into an isolated
CODEX_HOME, starts the plugin MCP server, and runs a full plan-mode workflow.

Usage:
  npm run smoke:codex-plugin
  node scripts/smoke-codex-plugin.mjs [--keep-temp] [--source <marketplace>] [--ref <git-ref>]

Defaults:
  source: ${defaultMarketplaceSource}
  ref:    ${defaultMarketplaceRef}

Environment:
  DEVCREW_SMOKE_MARKETPLACE_SOURCE  Override marketplace source.
  DEVCREW_SMOKE_MARKETPLACE_REF     Override marketplace git ref.
  DEVCREW_SMOKE_CODEX_BIN           Override Codex executable.
`;
}

function parseArgs(argv) {
  const options = {
    keepTemp: false,
    source: process.env.DEVCREW_SMOKE_MARKETPLACE_SOURCE || defaultMarketplaceSource,
    ref: process.env.DEVCREW_SMOKE_MARKETPLACE_REF || defaultMarketplaceRef,
    codexBin: process.env.DEVCREW_SMOKE_CODEX_BIN || "codex",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(help());
      process.exit(0);
    }
    if (arg === "--keep-temp") {
      options.keepTemp = true;
      continue;
    }
    if (arg === "--source") {
      options.source = argv[++index];
      continue;
    }
    if (arg === "--ref") {
      options.ref = argv[++index];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.source) {
    throw new Error("Marketplace source cannot be empty.");
  }
  return options;
}

function log(message) {
  console.log(`[devcrew-smoke] ${message}`);
}

async function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      if (code === 0) {
        resolveRun({ stdout, stderr });
        return;
      }
      rejectRun(
        new Error(
          `${command} ${args.join(" ")} exited with ${code}\nSTDOUT:\n${stdout.trim()}\nSTDERR:\n${stderr.trim()}`,
        ),
      );
    });
  });
}

function marketplaceName(source) {
  const normalized = source.replace(/\/$/u, "");
  if (normalized === defaultMarketplaceSource || normalized.endsWith("/lishen802/devcrew")) {
    return "devcrew";
  }
  return basename(normalized).replace(/\.git$/u, "") || "devcrew";
}

async function readInstalledPlugin(codexBin, codexEnv, marketplace) {
  const result = await run(codexBin, ["plugin", "list", "--json", "--available"], { env: codexEnv });
  const parsed = JSON.parse(result.stdout);
  const installed = parsed.installed?.find(
    (entry) => entry.name === "devcrew" && entry.marketplaceName === marketplace && entry.installed === true,
  );
  if (!installed?.source?.path) {
    throw new Error(`Installed devcrew plugin was not found in marketplace ${marketplace}.`);
  }
  return installed;
}

class JsonRpcClient {
  constructor(command, args, env, cwd) {
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("close", (code) => {
      if (this.pending.size > 0) {
        this.rejectAll(new Error(`MCP server exited with ${code}\nSTDERR:\n${this.stderr.trim()}`));
      }
    });
  }

  handleStdout(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        continue;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Timed out waiting for ${method}\nSTDERR:\n${this.stderr.trim()}`));
      }, jsonRpcTimeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async close() {
    this.child.stdin.end();
    if (this.child.exitCode === null) {
      this.child.kill("SIGTERM");
    }
  }
}

function assertToolResult(name, result) {
  if (result?.isError) {
    const text = result.content?.map((entry) => entry.text).join("\n") || JSON.stringify(result);
    throw new Error(`${name} returned an MCP error: ${text}`);
  }
  return result;
}

async function callTool(client, name, args) {
  const result = await client.request("tools/call", { name, arguments: args });
  return assertToolResult(name, result);
}

async function runPlanWorkflow(client, cwd) {
  const start = await callTool(client, "devcrew_start", {
    cwd,
    mode: "feature",
    request: "Smoke test DevCrew planning flow for a small README update.",
  });
  const runId = start.structuredContent?.state?.runId;
  if (!runId || !String(runId).startsWith("dc-")) {
    throw new Error(`devcrew_start did not return a dc-* run id: ${JSON.stringify(start)}`);
  }

  const gates = ["requirements", "architecture", "implementation", "testing"];
  for (const gate of gates) {
    await callTool(client, "devcrew_approve", { cwd, gate, note: `smoke approved ${gate}` });
    await callTool(client, "devcrew_continue", { cwd });
  }

  const status = await callTool(client, "devcrew_status", { cwd });
  const state = status.structuredContent?.state;
  if (state?.status !== "complete" || state?.phase !== "complete") {
    throw new Error(`Expected complete workflow, got ${JSON.stringify(state)}`);
  }

  for (const name of ["requirements", "architecture", "implementation-plan", "test-report", "acceptance"]) {
    const artifact = await callTool(client, "devcrew_artifact", { cwd, name });
    const path = artifact.structuredContent?.artifact?.path;
    if (!path) {
      throw new Error(`Artifact ${name} did not include a path.`);
    }
  }

  return { runId };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tempRoot = await mkdtemp(join(tmpdir(), "devcrew-codex-smoke-"));
  const codexHome = join(tempRoot, "codex-home");
  const fixture = join(tempRoot, "fixture-repo");
  await mkdir(codexHome, { recursive: true });
  await mkdir(fixture, { recursive: true });
  await writeFile(join(fixture, "README.md"), "# DevCrew Smoke Fixture\n", "utf8");
  await writeFile(join(fixture, "AGENTS.md"), "Use concise Markdown and keep changes scoped.\n", "utf8");

  const codexEnv = { ...process.env, CODEX_HOME: codexHome };
  const marketplace = marketplaceName(options.source);

  try {
    log(`using isolated CODEX_HOME=${codexHome}`);
    log(`adding marketplace ${options.source} at ref ${options.ref}`);
    const addArgs = ["plugin", "marketplace", "add", options.source];
    if (options.ref) {
      addArgs.push("--ref", options.ref);
    }
    await run(options.codexBin, addArgs, { env: codexEnv });

    log(`installing devcrew@${marketplace}`);
    await run(options.codexBin, ["plugin", "add", `devcrew@${marketplace}`], { env: codexEnv });

    const installed = await readInstalledPlugin(options.codexBin, codexEnv, marketplace);
    log(`installed plugin path: ${installed.source.path}`);

    const mcpConfigPath = join(installed.source.path, ".mcp.json");
    const mcpConfig = JSON.parse(await readFile(mcpConfigPath, "utf8"));
    const server = mcpConfig.mcpServers?.devcrew;
    if (!server?.command || !Array.isArray(server.args)) {
      throw new Error(`Invalid DevCrew MCP config at ${mcpConfigPath}`);
    }
    log(`starting MCP server: ${server.command} ${server.args.join(" ")}`);

    const client = new JsonRpcClient(server.command, server.args, {
      ...process.env,
      ...(server.env || {}),
    }, fixture);
    try {
      await client.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "devcrew-codex-plugin-smoke", version: "0.1.2" },
      });
      client.notify("notifications/initialized", {});
      const tools = await client.request("tools/list", {});
      const toolNames = tools.tools?.map((tool) => tool.name) || [];
      for (const required of ["devcrew_start", "devcrew_continue", "devcrew_artifact"]) {
        if (!toolNames.includes(required)) {
          throw new Error(`MCP tools/list missing ${required}: ${toolNames.join(", ")}`);
        }
      }

      const { runId } = await runPlanWorkflow(client, fixture);
      log(`plan workflow completed: ${runId}`);
    } finally {
      await client.close();
    }

    log("Codex plugin marketplace smoke test passed.");
  } finally {
    if (options.keepTemp) {
      log(`kept temp directory: ${tempRoot}`);
    } else {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(`[devcrew-smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
