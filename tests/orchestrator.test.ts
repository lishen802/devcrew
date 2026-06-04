import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { approveWorkflow, startWorkflow } from "../packages/core/src/index.js";
import { continueOrchestratedWorkflow, startOrchestratedWorkflow } from "../packages/orchestrator/src/index.js";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "devcrew-orchestrator-"));
}

test("startOrchestratedWorkflow runs the PM role before opening the requirements gate", async () => {
  const cwd = await tempProject();

  const started = await startOrchestratedWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Add billing export",
    backend: "local",
  });

  assert.equal(started.phase, "requirements");
  assert.equal(started.status, "awaiting_approval");
  assert.equal(started.gates.requirements, "pending");
  assert.equal(started.roles.at(-1)?.role, "pm");

  const requirementsPath = started.artifacts.requirements;
  assert.ok(requirementsPath);
  const requirements = await readFile(requirementsPath, "utf8");
  assert.match(requirements, /pm prepared deterministic Requirements fallback/);
  assert.match(requirements, /Role: pm/);
  assert.doesNotMatch(requirements, /## Product Boundary/);
});

test("continueOrchestratedWorkflow runs the phase role and writes its markdown artifact", async () => {
  const cwd = await tempProject();
  const started = await startWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Add release note generation",
    backend: "local",
  });
  await approveWorkflow({ cwd, runId: started.runId, gate: "requirements" });

  const continued = await continueOrchestratedWorkflow({ cwd, runId: started.runId });

  assert.equal(continued.phase, "architecture");
  assert.equal(continued.status, "awaiting_approval");
  assert.equal(continued.gates.architecture, "pending");
  assert.equal(continued.roles.at(-1)?.role, "architect");
  assert.equal(continued.roles.at(-1)?.backend, "local");

  const architecturePath = continued.artifacts.architecture;
  assert.ok(architecturePath);
  const architecture = await readFile(architecturePath, "utf8");
  assert.match(architecture, /architect prepared deterministic Architecture fallback/);
  assert.match(architecture, /Role: architect/);
  assert.doesNotMatch(architecture, /## Proposed Components/);
});
