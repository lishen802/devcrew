import test from "node:test";
import assert from "node:assert/strict";

import {
  renderRolePrompt,
  resolveBackendName,
  runRole,
} from "../packages/adapters/src/index.js";

test("resolveBackendName prefers the current host unless config overrides it", () => {
  assert.equal(resolveBackendName({ host: "codex" }), "codex");
  assert.equal(resolveBackendName({ host: "claude" }), "claude");
  assert.equal(resolveBackendName({ host: "codex", configuredBackend: "claude" }), "claude");
});

test("renderRolePrompt includes role, phase, request, standards, and artifact path", () => {
  const prompt = renderRolePrompt({
    role: "architect",
    phase: "architecture",
    request: "Build a workflow service",
    mode: "greenfield",
    standards: "Use TypeScript strict mode.",
    artifactPath: "docs/devcrew/af-demo/architecture.md",
  });

  assert.match(prompt, /Role: architect/);
  assert.match(prompt, /Phase: architecture/);
  assert.match(prompt, /Build a workflow service/);
  assert.match(prompt, /Use TypeScript strict mode/);
  assert.match(prompt, /architecture.md/);
});

test("renderRolePrompt includes prior artifacts for downstream roles", () => {
  const prompt = renderRolePrompt({
    role: "implementer",
    phase: "implementation",
    request: "Add SSO login",
    mode: "feature",
    standards: "Run npm test.",
    artifactPath: "docs/devcrew/af-demo/implementation-plan.md",
    priorArtifacts: {
      requirements: "# Requirements\n\nOnly OIDC is in scope.",
      architecture: "# Architecture\n\nUse the existing auth module.",
    },
  });

  assert.match(prompt, /Prior Artifacts/);
  assert.match(prompt, /requirements/);
  assert.match(prompt, /Only OIDC is in scope/);
  assert.match(prompt, /architecture/);
  assert.match(prompt, /existing auth module/);
});

test("runRole falls back to deterministic local output when host SDKs are unavailable", async () => {
  const result = await runRole({
    backend: "codex",
    role: "tester",
    phase: "testing",
    request: "Add tests",
    mode: "feature",
    cwd: process.cwd(),
    standards: "Run npm test.",
    artifactPath: "docs/devcrew/af-demo/test-report.md",
  });

  assert.equal(result.backend, "codex");
  assert.equal(result.role, "tester");
  assert.match(result.summary, /tester/);
  assert.match(result.markdown, /Test Report/);
});
