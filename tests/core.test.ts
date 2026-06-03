import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  answerWorkflow,
  approveWorkflow,
  continueWorkflow,
  discoverStandards,
  getArtifact,
  rejectWorkflow,
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
  assert.equal(state.gates.requirements, "pending");
  assert.match(state.runId, /^af-/);
  assert.ok(state.artifacts.requirements?.endsWith("requirements.md"));

  const artifact = await getArtifact({ cwd, runId: state.runId, name: "requirements" });
  assert.match(artifact.content, /Add audit logging/);
  assert.match(artifact.content, /Use Node 20/);
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
