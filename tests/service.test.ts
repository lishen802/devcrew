import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { callDevCrewTool, listDevCrewTools } from "../packages/service/src/index.js";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "devcrew-service-"));
}

test("MCP tool registry exposes the planned DevCrew tools", () => {
  const names = listDevCrewTools().map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "devcrew_answer",
    "devcrew_approve",
    "devcrew_artifact",
    "devcrew_continue",
    "devcrew_reject",
    "devcrew_start",
    "devcrew_status",
  ]);
});

test("devcrew_start exposes explicit execution mode without making apply the default", () => {
  const start = listDevCrewTools().find((tool) => tool.name === "devcrew_start");
  assert.ok(start);
  assert.deepEqual(start.inputSchema.properties.executionMode, {
    type: "string",
    enum: ["plan", "apply"],
    description: "Execution mode. Defaults to plan; apply must be explicit.",
  });
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
  assert.match(artifact.content[0].text, /## Proposed Components/);
  assert.match(artifact.content[0].text, /Architecture/);
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
