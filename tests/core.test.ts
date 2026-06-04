import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  answerWorkflow,
  approveWorkflow,
  continueWorkflow,
  discoverVerifyCommands,
  discoverStandards,
  DEVCREW_VERSION,
  getArtifact,
  loadState,
  rejectWorkflow,
  runDir,
  startWorkflow,
} from "../packages/core/src/index.js";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "devcrew-core-"));
}

test("startWorkflow creates a persisted run with a requirements approval gate", async () => {
  const cwd = await tempProject();
  await writeFile(join(cwd, "AGENTS.md"), "Use Node 20 and keep changes small.\n");

  const state = await startWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Add audit logging to the billing API",
  });

  assert.equal(state.phase, "requirements");
  assert.equal(state.status, "awaiting_approval");
  assert.equal(state.backend, "codex");
  assert.equal(state.executionMode, "plan");
  assert.equal(state.gates.requirements, "pending");
  assert.match(state.runId, /^dc-/);
  assert.ok(state.artifacts.requirements?.endsWith("requirements.md"));

  const artifact = await getArtifact({ cwd, runId: state.runId, name: "requirements" });
  assert.match(artifact.content, /Add audit logging/);
  assert.match(artifact.content, /Use Node 20/);
});

test("startWorkflow persists explicit apply execution mode", async () => {
  const cwd = await tempProject();

  const state = await startWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Implement audit logging",
    executionMode: "apply",
  });

  assert.equal(state.executionMode, "apply");

  const loaded = await loadState(cwd, state.runId);
  assert.equal(loaded.executionMode, "apply");
});

test("approveWorkflow and continueWorkflow advance through gated stages idempotently", async () => {
  const cwd = await tempProject();
  const first = await startWorkflow({
    cwd,
    host: "claude",
    mode: "greenfield",
    request: "Build a small issue tracker",
  });

  const afterRequirements = await approveWorkflow({
    cwd,
    runId: first.runId,
    gate: "requirements",
    note: "Scope looks right",
  });
  assert.equal(afterRequirements.phase, "architecture");
  assert.equal(afterRequirements.status, "ready");

  const architecture = await continueWorkflow({ cwd, runId: first.runId });
  assert.equal(architecture.phase, "architecture");
  assert.equal(architecture.status, "awaiting_approval");
  assert.equal(architecture.gates.architecture, "pending");
  assert.ok(architecture.artifacts.architecture?.endsWith("architecture.md"));

  const repeated = await continueWorkflow({ cwd, runId: first.runId });
  assert.deepEqual(repeated.artifacts, architecture.artifacts);
  assert.equal(repeated.status, "awaiting_approval");
});

test("rejectWorkflow records feedback and answerWorkflow returns the gate to pending", async () => {
  const cwd = await tempProject();
  const state = await startWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Improve search relevance",
  });

  const rejected = await rejectWorkflow({
    cwd,
    runId: state.runId,
    gate: "requirements",
    feedback: "Need explicit out-of-scope items",
  });
  assert.equal(rejected.status, "awaiting_input");
  assert.equal(rejected.gates.requirements, "rejected");
  assert.equal(rejected.feedback.at(-1)?.message, "Need explicit out-of-scope items");

  const answered = await answerWorkflow({
    cwd,
    runId: state.runId,
    answer: "Out of scope: analytics dashboard and mobile support.",
  });
  assert.equal(answered.status, "awaiting_approval");
  assert.equal(answered.gates.requirements, "pending");

  const artifact = await getArtifact({ cwd, runId: state.runId, name: "requirements" });
  assert.match(artifact.content, /Out of scope: analytics dashboard/);
});

test("fallback artifacts include requester answers and rejection feedback beyond requirements", async () => {
  const cwd = await tempProject();
  const state = await startWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Add billing exports",
    backend: "local",
  });
  await rejectWorkflow({
    cwd,
    runId: state.runId,
    gate: "requirements",
    feedback: "Clarify export format",
  });
  await answerWorkflow({
    cwd,
    runId: state.runId,
    answer: "CSV is required; PDF is out of scope.",
  });
  await approveWorkflow({ cwd, runId: state.runId, gate: "requirements" });
  await continueWorkflow({ cwd, runId: state.runId });

  const architecture = await getArtifact({ cwd, runId: state.runId, name: "architecture" });
  assert.match(architecture.content, /Requester Answers/);
  assert.match(architecture.content, /CSV is required/);
  assert.match(architecture.content, /Rejection Feedback/);
  assert.match(architecture.content, /Clarify export format/);
});

test("saveState writes a loadable state without leaving temp files", async () => {
  const cwd = await tempProject();
  const state = await startWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Add export history",
  });

  const loaded = await loadState(cwd, state.runId);
  assert.equal(loaded.runId, state.runId);
  JSON.parse(await readFile(join(runDir(cwd, state.runId), "state.json"), "utf8"));

  const files = await readdir(runDir(cwd, state.runId));
  assert.equal(files.some((file) => file.includes(".tmp")), false);
});

test("core exports the shared DevCrew version", () => {
  assert.equal(DEVCREW_VERSION, "0.1.0");
});

test("discoverStandards prefers explicit DevCrew standards and includes project conventions", async () => {
  const cwd = await tempProject();
  await writeFile(join(cwd, "AGENTS.md"), "Follow repo agent rules.\n");
  await writeFile(join(cwd, "README.md"), "# Demo\nRun npm test.\n");
  await writeFile(join(cwd, "package.json"), "{\"scripts\":{\"test\":\"node --test\"}}\n");
  await writeFile(join(cwd, ".devcrew-standards.md"), "Legacy file should not be loaded.\n");
  await writeFile(join(cwd, ".devcrew", "standards.md"), "Prefer explicit standards.\n").catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(cwd, ".devcrew"), { recursive: true });
    await writeFile(join(cwd, ".devcrew", "standards.md"), "Prefer explicit standards.\n");
  });

  const standards = await discoverStandards(cwd);

  assert.match(standards.combined, /Prefer explicit standards/);
  assert.match(standards.combined, /Follow repo agent rules/);
  assert.match(standards.combined, /package.json scripts: test/);
  assert.ok(standards.sources.some((source) => source.endsWith(".devcrew/standards.md")));
});

test("discoverVerifyCommands prefers configured package validation scripts", async () => {
  const cwd = await tempProject();
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      scripts: {
        lint: "eslint .",
        test: "node --test",
        validate: "npm run lint && npm test",
      },
    }),
  );

  assert.deepEqual(await discoverVerifyCommands(cwd), ["npm run validate"]);
});

test("discoverVerifyCommands falls back to common project manifests", async () => {
  const goProject = await tempProject();
  await writeFile(join(goProject, "go.mod"), "module example.com/demo\n");
  assert.deepEqual(await discoverVerifyCommands(goProject), ["go test ./..."]);

  const cargoProject = await tempProject();
  await writeFile(join(cargoProject, "Cargo.toml"), "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n");
  assert.deepEqual(await discoverVerifyCommands(cargoProject), ["cargo test"]);
});
