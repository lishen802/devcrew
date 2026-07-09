import test from "node:test";
import assert from "node:assert/strict";

import {
  checkHostSdkResolution,
  HOST_SDK_PACKAGES,
  missingRoleSections,
  renderRolePrompt,
  resolveBackendName,
  roleGuidance,
  runRole,
  type ModuleLoader,
} from "../packages/adapters/src/index.js";

test("resolveBackendName prefers the current host unless config overrides it", () => {
  assert.equal(resolveBackendName({ host: "codex" }), "codex");
  assert.equal(resolveBackendName({ host: "claude" }), "claude");
  assert.equal(resolveBackendName({ host: "codex", configuredBackend: "claude" }), "claude");
});

test("HOST_SDK_PACKAGES pins the packages DevCrew must resolve for real host backends", () => {
  assert.deepEqual(HOST_SDK_PACKAGES, {
    codex: "@openai/codex-sdk",
    claude: "@anthropic-ai/claude-agent-sdk",
  });
});

test("checkHostSdkResolution reports host SDK availability without invoking a role", async () => {
  const loadModule: ModuleLoader = async (specifier) => ({ specifier });

  assert.deepEqual(await checkHostSdkResolution("codex", { loadModule }), {
    backend: "codex",
    packageName: "@openai/codex-sdk",
    available: true,
  });
  assert.deepEqual(await checkHostSdkResolution("local", { loadModule }), {
    backend: "local",
    packageName: "local",
    available: true,
  });
});

test("checkHostSdkResolution reports the package name and import failure", async () => {
  const loadModule: ModuleLoader = async () => {
    throw new Error("module not found");
  };

  const result = await checkHostSdkResolution("claude", { loadModule });

  assert.equal(result.backend, "claude");
  assert.equal(result.packageName, "@anthropic-ai/claude-agent-sdk");
  assert.equal(result.available, false);
  assert.match(result.error ?? "", /module not found/);
});

test("renderRolePrompt includes role, phase, request, standards, and artifact path", () => {
  const prompt = renderRolePrompt({
    role: "architect",
    phase: "architecture",
    request: "Build a workflow service",
    mode: "greenfield",
    standards: "Use TypeScript strict mode.",
    artifactPath: "docs/devcrew/dc-demo/architecture.md",
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
    artifactPath: "docs/devcrew/dc-demo/implementation-plan.md",
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
  const loadModule: ModuleLoader = async () => {
    throw new Error("Cannot find package @openai/codex-sdk");
  };

  const result = await runRole({
    backend: "codex",
    role: "tester",
    phase: "testing",
    request: "Add tests",
    mode: "feature",
    cwd: process.cwd(),
    standards: "Run npm test.",
    artifactPath: "docs/devcrew/dc-demo/test-report.md",
  }, { loadModule });

  assert.equal(result.backend, "codex");
  assert.equal(result.role, "tester");
  assert.match(result.summary, /tester/);
  assert.match(result.markdown, /Test Report/);
});

test("runRole fails apply mode when the selected host SDK is unavailable", async () => {
  const loadModule: ModuleLoader = async () => {
    throw new Error("Cannot find package @openai/codex-sdk");
  };

  await assert.rejects(
    () =>
      runRole({
        backend: "codex",
        role: "implementer",
        phase: "implementation",
        request: "Change repository files",
        mode: "feature",
        executionMode: "apply",
        cwd: process.cwd(),
        standards: "Run npm test.",
        artifactPath: "docs/devcrew/dc-demo/implementation-plan.md",
      }, { loadModule }),
    /Cannot run DevCrew apply mode with unavailable codex SDK: .*@openai\/codex-sdk.*--include=optional/,
  );
});

test("roleGuidance returns structured H2 sections for each role", () => {
  for (const role of ["pm", "architect", "implementer", "tester"] as const) {
    const guidance = roleGuidance(role);
    assert.ok(guidance.length > 0, `roleGuidance should return sections for ${role}`);
    assert.match(guidance[0], /Produce these exact H2 sections:/);
    const headings = guidance.filter((line) => line.startsWith("## "));
    assert.ok(headings.length > 0, `roleGuidance should include H2 headings for ${role}`);
    // H2 lines must contain only the exact heading. Descriptions belong on
    // separate guidance lines so generated markdown can be validated reliably.
    for (const line of headings) {
      assert.match(line, /^## /);
      assert.doesNotMatch(line, / - /);
    }
  }
});

test("roleGuidance returns empty for conductor and unknown roles", () => {
  assert.deepEqual(roleGuidance("conductor"), []);
});

test("missingRoleSections reports SDK markdown that omits required H2 headings", () => {
  assert.deepEqual(
    missingRoleSections(
      "architect",
      [
        "# Architecture",
        "",
        "## Technical Decisions",
        "",
        "Use the existing service boundary.",
      ].join("\n"),
    ),
    ["Interface Contracts", "Data Flow and Deployment", "Architecture Review Checklist"],
  );
});

test("runRole falls back in plan mode when SDK output misses required sections", async () => {
  const loadModule: ModuleLoader = async () => ({
    Codex: class {
      startThread() {
        return { run: async () => ({ finalResponse: "# Architecture\n\nNo required H2 sections." }) };
      }
    },
  });

  const result = await runRole({
    backend: "codex",
    role: "architect",
    phase: "architecture",
    request: "Add billing export",
    mode: "feature",
    cwd: process.cwd(),
    standards: "Use TypeScript strict mode.",
    artifactPath: "docs/devcrew/dc-demo/architecture.md",
  }, { loadModule });

  assert.equal(result.usedFallback, true);
  assert.match(result.summary, /missing required sections/i);
});

test("runRole fails apply mode when SDK output misses required sections", async () => {
  const loadModule: ModuleLoader = async () => ({
    Codex: class {
      startThread() {
        return { run: async () => ({ finalResponse: "# Implementation\n\nNo required H2 sections." }) };
      }
    },
  });

  await assert.rejects(
    () =>
      runRole({
        backend: "codex",
        role: "implementer",
        phase: "implementation",
        request: "Change repository files",
        mode: "feature",
        executionMode: "apply",
        cwd: process.cwd(),
        standards: "Run npm test.",
        artifactPath: "docs/devcrew/dc-demo/implementation-plan.md",
      }, { loadModule }),
    /missing required sections/i,
  );
});
