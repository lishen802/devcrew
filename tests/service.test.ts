import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

import { callDevCrewTool, listDevCrewTools } from "../packages/service/src/index.js";
import { continueOrchestratedWorkflow, startOrchestratedWorkflow } from "../packages/orchestrator/src/index.js";
import { approveWorkflow, type RoleResult } from "../packages/core/src/index.js";
import type { RoleRunInput } from "../packages/adapters/src/index.js";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "devcrew-service-"));
}

const execFileAsync = promisify(execFile);

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("MCP tool registry exposes the planned DevCrew tools", () => {
  const names = listDevCrewTools().map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "devcrew_answer",
    "devcrew_approve",
    "devcrew_artifact",
    "devcrew_complete_execution",
    "devcrew_continue",
    "devcrew_reject",
    "devcrew_start",
    "devcrew_status",
    "devcrew_waive_verification",
  ]);
});

test("devcrew_start exposes explicit execution mode without making apply the default", () => {
  const start = listDevCrewTools().find((tool) => tool.name === "devcrew_start");
  assert.ok(start);
  assert.deepEqual(start.inputSchema.required, ["cwd", "mode", "request"]);
  assert.deepEqual(start.inputSchema.properties.executionMode, {
    type: "string",
    enum: ["plan", "apply"],
    description: "Execution mode. Defaults to plan; apply must be explicit.",
  });
});

test("run-scoped MCP tools can omit runId and use the active run", async () => {
  const cwd = await tempProject();

  const start = await callDevCrewTool("devcrew_start", {
    cwd,
    mode: "feature",
    request: "Add active run support",
    backend: "local",
  });
  assert.equal(start.isError, false);
  const runId = (start.structuredContent?.state as { runId: string }).runId;

  const status = await callDevCrewTool("devcrew_status", { cwd });
  assert.equal(status.isError, false);
  assert.match(status.content[0].text, new RegExp(runId));

  const approval = await callDevCrewTool("devcrew_approve", {
    cwd,
    gate: "requirements",
    note: "Approved through active run",
  });
  assert.equal(approval.isError, false);
  assert.match(approval.content[0].text, /architecture/);

  const continued = await callDevCrewTool("devcrew_continue", { cwd });
  assert.equal(continued.isError, false);
  assert.match(continued.content[0].text, /architecture/);

  const artifact = await callDevCrewTool("devcrew_artifact", {
    cwd,
    name: "architecture",
  });
  assert.equal(artifact.isError, false);
  assert.match(artifact.content[0].text, /Architecture/);
});

test("devcrew_start infers host from DEVCREW_HOST when host is omitted", async () => {
  const cwd = await tempProject();
  const previous = process.env.DEVCREW_HOST;
  process.env.DEVCREW_HOST = "claude";
  try {
    const start = await callDevCrewTool("devcrew_start", {
      cwd,
      mode: "feature",
      request: "Infer host from environment",
      backend: "local",
    });

    assert.equal(start.isError, false);
    assert.equal((start.structuredContent?.state as { host: string }).host, "claude");
  } finally {
    if (previous === undefined) {
      delete process.env.DEVCREW_HOST;
    } else {
      process.env.DEVCREW_HOST = previous;
    }
  }
});

test("devcrew_artifact exposes the implementation review artifact", () => {
  const artifact = listDevCrewTools().find((tool) => tool.name === "devcrew_artifact");
  assert.ok(artifact);
  const name = artifact.inputSchema.properties.name as { enum: string[] };
  assert.ok(name.enum.includes("implementation-review"));
});

test("MCP tool calls create, inspect, approve, continue, and read artifacts", async () => {
  const cwd = await tempProject();

  const start = await callDevCrewTool("devcrew_start", {
    cwd,
    host: "codex",
    mode: "feature",
    request: "Add project-level release notes",
    backend: "local",
  });
  assert.equal(start.isError, false);
  assert.match(start.content[0].text, /requirements/);
  assert.match(start.content[0].text, /role_fallback=local/);
  const runId = (start.structuredContent?.state as { runId: string }).runId;
  const startState = start.structuredContent?.state as { roles: Array<{ role: string }> };
  assert.equal(startState.roles.at(-1)?.role, "pm");

  const status = await callDevCrewTool("devcrew_status", { cwd, runId });
  assert.match(status.content[0].text, /awaiting_approval/);

  const approval = await callDevCrewTool("devcrew_approve", {
    cwd,
    runId,
    gate: "requirements",
    note: "Approved",
  });
  assert.match(approval.content[0].text, /architecture/);

  const continued = await callDevCrewTool("devcrew_continue", { cwd, runId });
  assert.match(continued.content[0].text, /architecture/);
  assert.match(continued.content[0].text, /role_fallback=local/);

  const artifact = await callDevCrewTool("devcrew_artifact", {
    cwd,
    runId,
    name: "architecture",
  });
  assert.match(artifact.content[0].text, /## Technical Decisions/);
  assert.match(artifact.content[0].text, /Architecture/);
});

test("MCP testing approval promotes an isolated patch once", async () => {
  const cwd = await tempProject();
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.email", "devcrew@example.test"], { cwd });
  await execFileAsync("git", ["config", "user.name", "DevCrew Test"], { cwd });
  await writeFile(join(cwd, "README.md"), "# Service Fixture\n");
  await execFileAsync("git", ["add", "."], { cwd });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd });

  const runner = async (input: RoleRunInput): Promise<RoleResult> => {
    if (input.phase === "execution") {
      await writeFile(join(input.cwd, "generated.ts"), "export const generated = true;\n");
    }
    return {
      role: input.role,
      backend: input.backend,
      summary: `${input.role} completed`,
      markdown: `# ${input.role}\n\nCompleted ${input.phase}.\n`,
      usedFallback: false,
    };
  };
  const started = await startOrchestratedWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    executionMode: "apply",
    executionPolicy: "headless-restricted",
    request: "Add generated code",
    backend: "codex",
  }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "requirements" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "architecture" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "implementation" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "implementation-review" });
  const tested = await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  const workspacePath = tested.executionWorkspace?.path;
  assert.ok(workspacePath);
  assert.equal(await pathExists(join(cwd, "generated.ts")), false);

  const approved = await callDevCrewTool("devcrew_approve", {
    cwd,
    runId: started.runId,
    gate: "testing",
  });
  assert.equal(approved.isError, false);
  assert.equal(await readFile(join(cwd, "generated.ts"), "utf8"), "export const generated = true;\n");
  assert.equal(await pathExists(workspacePath), false);

  const duplicate = await callDevCrewTool("devcrew_approve", {
    cwd,
    runId: started.runId,
    gate: "testing",
  });
  assert.equal(duplicate.isError, false);
  assert.match(duplicate.content[0].text, /phase=acceptance/);
});

test("MCP tool calls return structured errors for invalid input", async () => {
  const result = await callDevCrewTool("devcrew_start", {
    cwd: "/tmp",
    host: "codex",
    mode: "unsupported",
    request: "Nope",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /mode/);
});

test("MCP apply start fails when the selected host SDK is unavailable", async () => {
  const cwd = await tempProject();

  // Simulate an unavailable SDK by injecting a runner that throws with the
  // same wrapping that runRole produces for a missing optional dependency.
  const unavailableRunner = async (_input: RoleRunInput): Promise<RoleResult> => {
    throw new Error(
      "Cannot run DevCrew apply mode with unavailable codex SDK: Cannot find package @openai/codex-sdk",
    );
  };

  await assert.rejects(
    () =>
      startOrchestratedWorkflow(
        {
          cwd,
          host: "codex",
          mode: "feature",
          executionMode: "apply",
          request: "Make a real repository change",
          backend: "codex",
        },
        unavailableRunner,
      ),
    /Cannot run DevCrew apply mode with unavailable codex SDK/,
  );
});
