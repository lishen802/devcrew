import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { approveWorkflow, rejectWorkflow, startWorkflow } from "../packages/core/src/index.js";
import {
  answerOrchestratedWorkflow,
  continueOrchestratedWorkflow,
  startOrchestratedWorkflow,
} from "../packages/orchestrator/src/index.js";
import type { RoleRunInput } from "../packages/adapters/src/index.js";
import type { RoleResult } from "../packages/core/src/index.js";

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
  assert.equal(started.roles.at(-1)?.usedFallback, true);
  assert.match(started.roles.at(-1)?.summary ?? "", /deterministic/);

  const requirementsPath = started.artifacts.requirements;
  assert.ok(requirementsPath);
  const requirements = await readFile(requirementsPath, "utf8");
  // The local backend has no SDK, so the artifact uses the rich phase template.
  assert.match(requirements, /## Product Boundary/);
  assert.match(requirements, /Add billing export/);
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
  assert.equal(continued.roles.at(-1)?.usedFallback, true);

  const architecturePath = continued.artifacts.architecture;
  assert.ok(architecturePath);
  const architecture = await readFile(architecturePath, "utf8");
  // The local backend has no SDK, so the artifact uses the rich phase template.
  assert.match(architecture, /## Proposed Components/);
  assert.match(architecture, /Add release note generation/);
});

test("continueOrchestratedWorkflow passes prior artifacts into the phase role", async () => {
  const cwd = await tempProject();
  const started = await startOrchestratedWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Add workspace invitations",
    backend: "local",
  });
  await approveWorkflow({ cwd, runId: started.runId, gate: "requirements" });

  let captured: RoleRunInput | undefined;
  const runner = async (input: RoleRunInput): Promise<RoleResult> => {
    captured = input;
    return {
      role: input.role,
      backend: input.backend,
      summary: "fake architecture",
      markdown: "# Fake Architecture\n",
      usedFallback: false,
    };
  };

  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);

  assert.equal(captured?.role, "architect");
  assert.match(captured?.priorArtifacts?.requirements ?? "", /Add workspace invitations/);
  assert.equal(captured?.priorArtifacts?.architecture, undefined);
});

test("answerOrchestratedWorkflow re-runs the role and folds the answer into the artifact", async () => {
  const cwd = await tempProject();
  const started = await startOrchestratedWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Add SSO login",
    backend: "local",
  });

  await rejectWorkflow({
    cwd,
    runId: started.runId,
    gate: "requirements",
    feedback: "List the out-of-scope items explicitly",
  });

  const answered = await answerOrchestratedWorkflow({
    cwd,
    runId: started.runId,
    answer: "Out of scope: SAML and social login providers.",
  });

  assert.equal(answered.phase, "requirements");
  assert.equal(answered.status, "awaiting_approval");
  assert.equal(answered.gates.requirements, "pending");
  assert.equal(answered.roles.at(-1)?.role, "pm");

  const requirementsPath = answered.artifacts.requirements;
  assert.ok(requirementsPath);
  const requirements = await readFile(requirementsPath, "utf8");
  // The re-run keeps the rich phase template rather than reverting silently,
  // and the recorded answer plus rejection feedback are folded back in.
  assert.match(requirements, /## Product Boundary/);
  assert.match(requirements, /Out of scope: SAML and social login providers/);
  assert.match(requirements, /List the out-of-scope items explicitly/);
});
