import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

import { abortWorkflow, approveWorkflow, getWorkflowStatus, rejectWorkflow, startWorkflow, statePath } from "../packages/core/src/index.js";
import {
  abortOrchestratedWorkflow,
  answerOrchestratedWorkflow,
  approveOrchestratedWorkflow,
  completeOrchestratedExecution,
  continueOrchestratedWorkflow,
  rejectOrchestratedWorkflow,
  runShellCommand,
  startOrchestratedWorkflow,
  waiveOrchestratedVerification,
  recoverOrchestratedWorkflow,
} from "../packages/orchestrator/src/index.js";
import type { RoleRunInput } from "../packages/adapters/src/index.js";
import type { RoleResult } from "../packages/core/src/index.js";

const execFileAsync = promisify(execFile);

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "devcrew-orchestrator-"));
}

async function initGitRepo(cwd: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.email", "devcrew@example.test"], { cwd });
  await execFileAsync("git", ["config", "user.name", "DevCrew Test"], { cwd });
  await writeFile(join(cwd, "README.md"), "# Test Project\n");
  await execFileAsync("git", ["add", "."], { cwd });
  await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd });
}

async function configureSuccessfulVerification(cwd: string): Promise<void> {
  await mkdir(join(cwd, ".devcrew"), { recursive: true });
  const verifyCommand = `${process.execPath} -e "console.log('devcrew-verify-ok')"`;
  await writeFile(
    join(cwd, ".devcrew", "config.json"),
    `${JSON.stringify({
      version: 1,
      defaultBackend: "codex",
      executionMode: "apply",
      workflow: {
        gates: ["requirements", "architecture", "implementation", "testing"],
        artifactDirectory: "docs/devcrew",
      },
      verifyCommands: [verifyCommand],
    }, null, 2)}\n`,
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function validRoleResult(input: RoleRunInput): RoleResult {
  return {
    role: input.role,
    backend: input.backend,
    summary: `${input.role} completed`,
    markdown: `# ${input.role}\n\nCompleted ${input.phase}.\n`,
    usedFallback: false,
    reviewDecision: input.phase === "review" ? "approved" : undefined,
  };
}

async function advanceApplyToTestingGate(
  cwd: string,
  runner: (input: RoleRunInput) => Promise<RoleResult>,
): Promise<Awaited<ReturnType<typeof startOrchestratedWorkflow>>> {
  const started = await startOrchestratedWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Add generated code",
    backend: "codex",
    executionMode: "apply",
    executionPolicy: "headless-restricted",
  }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "requirements" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "architecture" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "implementation" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "implementation-review" });
  return continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
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
  assert.equal(started.roles.at(-2)?.role, "conductor");
  assert.match(started.roles.at(-2)?.summary ?? "", /requirements phase to pm/i);
  assert.equal(started.roles.at(-1)?.role, "pm");
  assert.equal(started.roles.at(-1)?.usedFallback, true);
  assert.match(started.roles.at(-1)?.summary ?? "", /deterministic/);

  const requirementsPath = started.artifacts.requirements;
  assert.ok(requirementsPath);
  const requirements = await readFile(requirementsPath, "utf8");
  // The local backend has no SDK, so the artifact uses the rich phase template.
  assert.match(requirements, /DevCrew local fallback/);
  assert.match(requirements, /## Functional Scope/);
  assert.match(requirements, /## Acceptance Criteria/);
  assert.match(requirements, /Add billing export/);
});

test("PM questions move the workflow to awaiting_input until the requester responds", async () => {
  const cwd = await tempProject();
  let pmCalls = 0;
  let receivedAnswers: string[] | undefined;
  const runner = async (input: RoleRunInput): Promise<RoleResult> => {
    if (input.role === "pm") {
      pmCalls += 1;
      receivedAnswers = input.answers;
      return {
        ...validRoleResult(input),
        questions: pmCalls === 1 ? ["Which billing export formats are required?"] : [],
      };
    }
    return validRoleResult(input);
  };

  const started = await startOrchestratedWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Add billing export",
    backend: "codex",
  }, runner);
  assert.equal(started.status, "awaiting_input");
  assert.equal(started.gates.requirements, "not_started");
  assert.deepEqual(started.pendingQuestions, ["Which billing export formats are required?"]);

  const answered = await answerOrchestratedWorkflow({
    cwd,
    runId: started.runId,
    answer: "CSV and JSON are required.",
  }, runner);
  assert.equal(answered.status, "awaiting_approval");
  assert.equal(answered.gates.requirements, "pending");
  assert.deepEqual(answered.pendingQuestions, []);
  assert.deepEqual(receivedAnswers, ["CSV and JSON are required."]);
});

test("configured optional gates advance without bypassing the workflow", async () => {
  const cwd = await tempProject();
  await mkdir(join(cwd, ".devcrew"), { recursive: true });
  await writeFile(
    join(cwd, ".devcrew", "config.json"),
    JSON.stringify({
      version: 1,
      defaultBackend: "local",
      executionMode: "plan",
      verifyCommands: [],
      lintCommands: [],
      coverageCommands: [],
      workflow: {
        gates: ["architecture", "implementation"],
        artifactDirectory: "docs/devcrew",
      },
    }),
  );

  const started = await startOrchestratedWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Skip requirements approval only",
    backend: "local",
  });
  assert.equal(started.phase, "architecture");
  assert.equal(started.status, "ready");
  assert.equal(started.gates.requirements, "not_started");
  assert.equal(started.gates.testing, "not_started");
  assert.equal(started.gates["implementation-review"], "not_started");
  assert.deepEqual(
    started.enabledGates,
    ["architecture", "implementation", "implementation-review", "testing"],
  );

  const architecture = await continueOrchestratedWorkflow({ cwd, runId: started.runId });
  assert.equal(architecture.phase, "architecture");
  assert.equal(architecture.status, "awaiting_approval");
  assert.equal(architecture.gates.architecture, "pending");
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
  assert.equal(continued.roles.at(-2)?.role, "conductor");
  assert.match(continued.roles.at(-2)?.summary ?? "", /architecture phase to architect/i);
  assert.equal(continued.roles.at(-1)?.role, "architect");
  assert.equal(continued.roles.at(-1)?.backend, "local");
  assert.equal(continued.roles.at(-1)?.usedFallback, true);

  const architecturePath = continued.artifacts.architecture;
  assert.ok(architecturePath);
  const architecture = await readFile(architecturePath, "utf8");
  // The local backend has no SDK, so the artifact uses the rich phase template.
  assert.match(architecture, /DevCrew local fallback/);
  assert.match(architecture, /## Technical Decisions/);
  assert.match(architecture, /## Interface Contracts/);
  assert.match(architecture, /Add release note generation/);
});

test("orchestrated SDK fallback artifacts include a warning and reason", async () => {
  const cwd = await tempProject();
  const runner = async (input: RoleRunInput): Promise<RoleResult> => ({
    role: input.role,
    backend: input.backend,
    summary: "Cannot find package @openai/codex-sdk",
    markdown: "# Requirements\n\nFallback.",
    usedFallback: true,
  });
  const started = await startOrchestratedWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Add changelog generation",
    backend: "codex",
  }, runner);

  const requirementsPath = started.artifacts.requirements;
  assert.ok(requirementsPath);
  const requirements = await readFile(requirementsPath, "utf8");
  assert.match(requirements, /DevCrew SDK fallback/);
  assert.match(requirements, /codex SDK was unavailable/);
  assert.match(requirements, /Cannot find package @openai\/codex-sdk/);
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
  assert.match(requirements, /## Functional Scope/);
  assert.match(requirements, /Out of scope: SAML and social login providers/);
  assert.match(requirements, /List the out-of-scope items explicitly/);
});

test("apply mode plans read-only before executing in a worktree", async () => {
  const cwd = await tempProject();
  await initGitRepo(cwd);
  const calls: RoleRunInput[] = [];
  const runner = async (input: RoleRunInput): Promise<RoleResult> => {
    calls.push(input);
    if (input.phase === "execution") {
      await writeFile(join(input.cwd, "generated.ts"), "export const generated = true;\n");
    }
    return validRoleResult(input);
  };
  const started = await startOrchestratedWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Add generated code",
    backend: "codex",
    executionMode: "apply",
    executionPolicy: "headless-restricted",
  }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "requirements" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "architecture" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);

  assert.equal(calls.at(-1)?.phase, "implementation");
  assert.equal(calls.at(-1)?.executionMode, "apply");
  assert.equal(calls.at(-1)?.cwd, cwd);
  assert.equal(await pathExists(join(cwd, "generated.ts")), false);

  await approveWorkflow({ cwd, runId: started.runId, gate: "implementation" });
  const executed = await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  assert.equal(calls.at(-1)?.phase, "execution");
  assert.equal(calls.at(-1)?.executionMode, "apply");
  assert.notEqual(calls.at(-1)?.cwd, cwd);
  assert.equal(executed.phase, "review");
  assert.equal(executed.status, "ready");
  assert.match(executed.implementationDiff, /generated\.ts/);
  assert.deepEqual(executed.changedFiles, ["generated.ts"]);
  assert.equal(await pathExists(join(cwd, "generated.ts")), false);

  const reviewed = await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  assert.equal(calls.at(-1)?.role, "architect");
  assert.equal(calls.at(-1)?.phase, "review");
  assert.equal(reviewed.status, "awaiting_approval");
  assert.equal(reviewed.gates["implementation-review"], "pending");
  assert.ok(reviewed.artifacts["architecture-review"]);
});

test("architecture review blocks testing when it requires changes", async () => {
  const cwd = await tempProject();
  await initGitRepo(cwd);
  const calls: RoleRunInput[] = [];
  const runner = async (input: RoleRunInput): Promise<RoleResult> => {
    calls.push(input);
    if (input.phase === "execution") {
      await writeFile(join(input.cwd, "generated.ts"), "export const generated = true;\n");
    }
    if (input.phase === "review") {
      return {
        ...validRoleResult(input),
        summary: "The generated API does not match the approved contract.",
        reviewDecision: "changes_required",
      };
    }
    return validRoleResult(input);
  };
  const started = await startOrchestratedWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Add generated code",
    backend: "codex",
    executionMode: "apply",
    executionPolicy: "headless-restricted",
  }, runner);

  await approveWorkflow({ cwd, runId: started.runId, gate: "requirements" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "architecture" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "implementation" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);

  const reviewed = await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  assert.equal(reviewed.phase, "review");
  assert.equal(reviewed.status, "awaiting_input");
  assert.equal(reviewed.gates["implementation-review"], "rejected");
  assert.equal(reviewed.architectureReview?.decision, "changes_required");
  assert.match(reviewed.feedback.at(-1)?.message ?? "", /does not match the approved contract/);
  assert.match(
    await readFile(reviewed.artifacts["architecture-review"] ?? "", "utf8"),
    /## Review Decision\n\nDecision: changes_required/,
  );
  await assert.rejects(
    () => approveWorkflow({ cwd, runId: started.runId, gate: "implementation-review" }),
    /not pending approval/,
  );

  const workspacePath = reviewed.executionWorkspace?.path;
  assert.ok(workspacePath);
  const revised = await answerOrchestratedWorkflow({
    cwd,
    runId: started.runId,
    answer: "Revise the generated API to match the approved contract.",
  }, runner);
  assert.equal(revised.phase, "execution");
  assert.equal(revised.status, "ready");
  assert.equal(revised.gates["implementation-review"], "not_started");
  assert.equal(revised.executionWorkspace?.path, workspacePath);

  const reexecuted = await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  assert.equal(calls.at(-1)?.phase, "execution");
  assert.equal(reexecuted.phase, "review");
  assert.equal(reexecuted.status, "ready");
});

test("interactive-host apply waits for native host execution and records its completion", async () => {
  const cwd = await tempProject();
  await initGitRepo(cwd);
  const calls: RoleRunInput[] = [];
  const runner = async (input: RoleRunInput): Promise<RoleResult> => {
    calls.push(input);
    return validRoleResult(input);
  };
  const started = await startOrchestratedWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Add a native-host generated module",
    backend: "codex",
    executionMode: "apply",
    executionPolicy: "interactive-host",
  }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "requirements" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "architecture" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "implementation" });

  const awaitingExecution = await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  const workspacePath = awaitingExecution.executionWorkspace?.path;
  assert.ok(workspacePath);
  assert.equal(awaitingExecution.status, "awaiting_execution");
  assert.equal(awaitingExecution.executionInstruction?.phase, "execution");
  assert.equal(calls.some((input) => input.phase === "execution"), false);

  await writeFile(join(workspacePath, "generated.ts"), "export const generated = true;\n");
  const readyForReview = await completeOrchestratedExecution({
    cwd,
    runId: started.runId,
    summary: "Implemented generated module with the native host.",
  });
  assert.equal(readyForReview.phase, "review");
  assert.equal(readyForReview.status, "ready");
  assert.match(readyForReview.implementationDiff, /generated\.ts/);

  const reviewed = await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  assert.equal(reviewed.status, "awaiting_approval");
  assert.equal(reviewed.gates["implementation-review"], "pending");
  assert.equal(calls.at(-1)?.role, "architect");
  await approveWorkflow({ cwd, runId: started.runId, gate: "implementation-review" });

  const awaitingTesting = await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  assert.equal(awaitingTesting.status, "awaiting_execution");
  assert.equal(awaitingTesting.executionInstruction?.phase, "testing");
  assert.equal(calls.some((input) => input.phase === "testing"), false);

  const tested = await completeOrchestratedExecution({
    cwd,
    runId: started.runId,
    summary: "Native host test run completed.",
    verification: [{
      command: "npm test",
      exitCode: 0,
      output: "all tests passed",
      startedAt: "2026-07-13T00:00:00.000Z",
      completedAt: "2026-07-13T00:00:01.000Z",
    }],
  });
  assert.equal(tested.status, "awaiting_approval");
  assert.equal(tested.gates.testing, "pending");
  assert.equal(tested.verificationStatus, "passed");
});

test("abort cleans an isolated execution workspace without touching the requester checkout", async () => {
  const cwd = await tempProject();
  await initGitRepo(cwd);
  const runner = async (input: RoleRunInput): Promise<RoleResult> => {
    if (input.phase === "execution") {
      await writeFile(join(input.cwd, "generated.ts"), "export const generated = true;\n");
    }
    return validRoleResult(input);
  };
  const started = await startOrchestratedWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Add generated code",
    backend: "codex",
    executionMode: "apply",
    executionPolicy: "headless-restricted",
  }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "requirements" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "architecture" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "implementation" });
  const executed = await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  const workspacePath = executed.executionWorkspace?.path;
  assert.ok(workspacePath);

  const aborted = await abortOrchestratedWorkflow({
    cwd,
    runId: started.runId,
    reason: "Requester cancelled the implementation.",
  });
  assert.equal(aborted.status, "aborted");
  assert.equal(aborted.executionWorkspace, undefined);
  assert.equal(await pathExists(workspacePath), false);
  assert.equal(await pathExists(join(cwd, "generated.ts")), false);
  assert.equal((await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner)).status, "aborted");
});

test("recovery cleans the retained worktree of an aborted run", async () => {
  const cwd = await tempProject();
  await initGitRepo(cwd);
  const runner = async (input: RoleRunInput): Promise<RoleResult> => {
    if (input.phase === "execution") {
      await writeFile(join(input.cwd, "generated.ts"), "export const generated = true;\n");
    }
    return validRoleResult(input);
  };
  const started = await startOrchestratedWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Recover generated code",
    backend: "codex",
    executionMode: "apply",
    executionPolicy: "headless-restricted",
  }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "requirements" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "architecture" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  await approveWorkflow({ cwd, runId: started.runId, gate: "implementation" });
  const executed = await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  const workspacePath = executed.executionWorkspace?.path;
  assert.ok(workspacePath);

  await abortWorkflow({ cwd, runId: started.runId, reason: "Persist cleanup for recovery." });
  const recovered = await recoverOrchestratedWorkflow({ cwd, runId: started.runId });
  assert.equal(recovered.status, "aborted");
  assert.equal(recovered.executionWorkspace, undefined);
  assert.equal(await pathExists(workspacePath), false);
});

test("failed verification blocks promotion until an explicit waiver is recorded", async () => {
  const cwd = await tempProject();
  await mkdir(join(cwd, ".devcrew"), { recursive: true });
  const failedCommand = `${process.execPath} -e "console.error('verification failed'); process.exit(1)"`;
  await writeFile(
    join(cwd, ".devcrew", "config.json"),
    `${JSON.stringify({
      version: 1,
      defaultBackend: "codex",
      executionMode: "apply",
      verifyCommands: [failedCommand],
      workflow: { gates: ["requirements", "architecture", "implementation", "testing"], artifactDirectory: "docs/devcrew" },
    }, null, 2)}\n`,
  );
  await initGitRepo(cwd);
  const runner = async (input: RoleRunInput): Promise<RoleResult> => {
    if (input.phase === "execution") {
      await writeFile(join(input.cwd, "generated.ts"), "export const generated = true;\n");
    }
    return validRoleResult(input);
  };

  const tested = await advanceApplyToTestingGate(cwd, runner);
  assert.equal(tested.status, "awaiting_input");
  assert.equal(tested.gates.testing, "rejected");
  assert.equal(tested.verificationStatus, "failed");
  const failedReport = await readFile(tested.artifacts["test-report"] ?? "", "utf8");
  assert.match(failedReport, /## Verification Outcome\n\nStatus: failed/);
  await assert.rejects(
    () => approveOrchestratedWorkflow({ cwd, runId: tested.runId, gate: "testing" }),
    /not pending approval/i,
  );
  assert.equal(await pathExists(join(cwd, "generated.ts")), false);

  const waived = await waiveOrchestratedVerification({
    cwd,
    runId: tested.runId,
    reason: "Known flaky external integration; reviewer accepts the risk.",
  });
  assert.equal(waived.status, "awaiting_approval");
  assert.equal(waived.gates.testing, "pending");
  assert.equal(waived.verificationWaiver?.reason, "Known flaky external integration; reviewer accepts the risk.");
  const waivedReport = await readFile(waived.artifacts["test-report"] ?? "", "utf8");
  assert.match(waivedReport, /## Verification Waiver/);
  assert.match(waivedReport, /Known flaky external integration/);

  await approveOrchestratedWorkflow({ cwd, runId: tested.runId, gate: "testing" });
  assert.equal(await readFile(join(cwd, "generated.ts"), "utf8"), "export const generated = true;\n");
});

test("missing verification blocks promotion until an explicit waiver is recorded", async () => {
  const cwd = await tempProject();
  await initGitRepo(cwd);
  const runner = async (input: RoleRunInput): Promise<RoleResult> => {
    if (input.phase === "execution") {
      await writeFile(join(input.cwd, "generated.ts"), "export const generated = true;\n");
    }
    return validRoleResult(input);
  };

  const tested = await advanceApplyToTestingGate(cwd, runner);
  assert.equal(tested.verificationStatus, "not_run");
  assert.equal(tested.gates.testing, "rejected");
  assert.equal(tested.status, "awaiting_input");
  await assert.rejects(
    () => approveOrchestratedWorkflow({ cwd, runId: tested.runId, gate: "testing" }),
    /not pending approval/i,
  );

  const persistedPath = statePath(cwd, tested.runId);
  const blockedState = JSON.parse(await readFile(persistedPath, "utf8"));
  await writeFile(
    persistedPath,
    `${JSON.stringify({
      ...blockedState,
      status: "awaiting_approval",
      gates: { ...blockedState.gates, testing: "pending" },
      verificationStatus: "not_run",
      verificationWaiver: undefined,
    }, null, 2)}\n`,
  );
  await assert.rejects(
    () => approveOrchestratedWorkflow({ cwd, runId: tested.runId, gate: "testing" }),
    /Verification must pass before promotion/i,
  );
  await writeFile(persistedPath, `${JSON.stringify(blockedState, null, 2)}\n`);

  const waived = await waiveOrchestratedVerification({
    cwd,
    runId: tested.runId,
    reason: "The fixture has no available test runner; reviewer accepts the documented risk.",
  });
  assert.equal(waived.gates.testing, "pending");
  assert.equal(waived.status, "awaiting_approval");

  await approveOrchestratedWorkflow({ cwd, runId: tested.runId, gate: "testing" });
  assert.equal(await readFile(join(cwd, "generated.ts"), "utf8"), "export const generated = true;\n");
});

test("testing approval promotes the reviewed patch exactly once", async () => {
  const cwd = await tempProject();
  await configureSuccessfulVerification(cwd);
  await initGitRepo(cwd);
  const runner = async (input: RoleRunInput): Promise<RoleResult> => {
    if (input.phase === "execution") {
      await writeFile(join(input.cwd, "generated.ts"), "export const generated = true;\n");
    }
    if (input.phase === "testing") {
      await writeFile(join(input.cwd, "tested.ts"), "export const tested = true;\n");
    }
    return validRoleResult(input);
  };
  const tested = await advanceApplyToTestingGate(cwd, runner);
  const workspacePath = tested.executionWorkspace?.path;
  assert.ok(workspacePath);
  assert.equal(tested.phase, "testing");
  assert.equal(tested.status, "awaiting_approval");
  assert.match(tested.implementationDiff, /tested\.ts/);
  assert.equal(await pathExists(join(cwd, "generated.ts")), false);

  await assert.rejects(
    () =>
      approveOrchestratedWorkflow({
        cwd,
        runId: tested.runId,
        gate: "testing",
        note: {} as never,
      }),
    /note must be a non-empty string/i,
  );
  assert.equal(await pathExists(join(cwd, "generated.ts")), false);
  assert.equal(await pathExists(workspacePath), true);
  assert.equal((await getWorkflowStatus({ cwd, runId: tested.runId })).gates.testing, "pending");

  const approved = await approveOrchestratedWorkflow({
    cwd,
    runId: tested.runId,
    gate: "testing",
  });
  assert.equal(approved.phase, "acceptance");
  assert.equal(approved.executionWorkspace, undefined);
  assert.equal(await readFile(join(cwd, "generated.ts"), "utf8"), "export const generated = true;\n");
  assert.equal(await readFile(join(cwd, "tested.ts"), "utf8"), "export const tested = true;\n");
  assert.equal(await pathExists(workspacePath), false);

  const duplicate = await approveOrchestratedWorkflow({
    cwd,
    runId: tested.runId,
    gate: "testing",
  });
  assert.equal(duplicate.phase, approved.phase);
  assert.deepEqual(duplicate.gates, approved.gates);
  assert.equal(duplicate.approvals.length, approved.approvals.length);

  const review = await readFile(approved.artifacts["implementation-review"] ?? "", "utf8");
  assert.match(review, /Implementation Diff Review/);
  assert.match(review, /Architecture Compliance Inputs/);
  assert.match(review, /Architecture Artifact: present/);
  assert.match(review, /Changed Files: 2/);
  assert.match(review, /Captured Diff: present/);
  assert.match(review, /Architecture Compliance Review/);
  assert.match(review, /Needs Human Review/);
  assert.match(review, /generated\.ts/);
});

test("rejected testing returns to execution without touching the requester repository", async () => {
  const cwd = await tempProject();
  await configureSuccessfulVerification(cwd);
  await initGitRepo(cwd);
  const runner = async (input: RoleRunInput): Promise<RoleResult> => {
    if (input.phase === "execution") {
      await writeFile(join(input.cwd, "generated.ts"), "export const generated = true;\n");
    }
    return validRoleResult(input);
  };
  const tested = await advanceApplyToTestingGate(cwd, runner);
  const workspacePath = tested.executionWorkspace?.path;
  assert.ok(workspacePath);

  await rejectOrchestratedWorkflow({
    cwd,
    runId: tested.runId,
    gate: "testing",
    feedback: "Revise the implementation",
  });
  const revised = await answerOrchestratedWorkflow({
    cwd,
    runId: tested.runId,
    answer: "Keep the change isolated and revise it",
  });

  assert.equal(revised.phase, "execution");
  assert.equal(revised.status, "ready");
  assert.equal(revised.gates.testing, "not_started");
  assert.equal(await pathExists(join(cwd, "generated.ts")), false);
  assert.equal(await pathExists(workspacePath), true);

  const revisionRunner = async (input: RoleRunInput): Promise<RoleResult> => {
    if (input.phase === "execution") {
      await writeFile(join(input.cwd, "generated.ts"), "export const generated = 'revised';\n");
    }
    return validRoleResult(input);
  };
  await continueOrchestratedWorkflow({ cwd, runId: tested.runId }, revisionRunner);
  await continueOrchestratedWorkflow({ cwd, runId: tested.runId }, revisionRunner);
  await approveWorkflow({ cwd, runId: tested.runId, gate: "implementation-review" });
  const retested = await continueOrchestratedWorkflow({ cwd, runId: tested.runId }, revisionRunner);
  assert.equal(retested.phase, "testing");
  assert.equal(retested.status, "awaiting_approval");
  assert.match(retested.implementationDiff, /generated = 'revised'/);

  await approveOrchestratedWorkflow({ cwd, runId: tested.runId, gate: "testing" });
  assert.equal(
    await readFile(join(cwd, "generated.ts"), "utf8"),
    "export const generated = 'revised';\n",
  );
  assert.equal(await pathExists(workspacePath), false);
});

test("apply mode tester runs configured verification and coverage commands", async () => {
  const cwd = await tempProject();
  await mkdir(join(cwd, ".devcrew"), { recursive: true });
  const verifyCommand = `${process.execPath} -e "console.log('devcrew-verify-ok')"`;
  const coverageCommand = `${process.execPath} -e "console.log('devcrew-coverage-ok')"`;
  await writeFile(
    join(cwd, ".devcrew", "config.json"),
    `${JSON.stringify({
      version: 1,
      defaultBackend: "codex",
      executionMode: "apply",
      workflow: {
        gates: ["requirements", "architecture", "implementation", "testing"],
        artifactDirectory: "docs/devcrew",
      },
      verifyCommands: [verifyCommand],
      coverageCommands: [coverageCommand],
    }, null, 2)}\n`,
  );
  await initGitRepo(cwd);
  const runner = async (input: RoleRunInput): Promise<RoleResult> => {
    if (input.phase === "execution") {
      await writeFile(join(input.cwd, "generated.ts"), "export const generated = true;\n");
    }
    return validRoleResult(input);
  };
  const tested = await advanceApplyToTestingGate(cwd, runner);

  assert.deepEqual(tested.verification.map((result) => result.command), [verifyCommand, coverageCommand]);
  assert.equal(tested.verification[0]?.exitCode, 0);
  assert.match(tested.verification[0]?.output ?? "", /devcrew-verify-ok/);
  assert.equal(tested.verification[1]?.exitCode, 0);
  assert.match(tested.verification[1]?.output ?? "", /devcrew-coverage-ok/);
  const testReportPath = tested.artifacts["test-report"];
  assert.ok(testReportPath);
  const testReport = await readFile(testReportPath, "utf8");
  assert.match(testReport, /Acceptance Evidence/);
  assert.match(testReport, /devcrew-verify-ok/);
  assert.match(testReport, /devcrew-coverage-ok/);
  assert.match(testReport, /Exit Code: 0/);
});

test("apply mode tester discovers package verification and coverage commands when none are configured", async () => {
  const cwd = await tempProject();
  await mkdir(join(cwd, ".devcrew"), { recursive: true });
  await writeFile(
    join(cwd, ".devcrew", "config.json"),
    `${JSON.stringify({
      version: 1,
      defaultBackend: "codex",
      executionMode: "apply",
      verifyCommands: [],
      workflow: {
        gates: ["requirements", "architecture", "implementation", "testing"],
        artifactDirectory: "docs/devcrew",
      },
    }, null, 2)}\n`,
  );
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      scripts: {
        test: `${process.execPath} -e "console.log('auto-npm-test-ok')"`,
        coverage: `${process.execPath} -e "console.log('auto-npm-coverage-ok')"`,
      },
    }),
  );
  await initGitRepo(cwd);
  const runner = async (input: RoleRunInput): Promise<RoleResult> => {
    if (input.phase === "execution") {
      await writeFile(join(input.cwd, "generated.ts"), "export const generated = true;\n");
    }
    return validRoleResult(input);
  };
  const tested = await advanceApplyToTestingGate(cwd, runner);

  assert.deepEqual(tested.verification.map((result) => result.command), ["npm test", "npm run coverage"]);
  assert.equal(tested.verification[0]?.exitCode, 0);
  assert.match(tested.verification[0]?.output ?? "", /auto-npm-test-ok/);
  assert.equal(tested.verification[1]?.exitCode, 0);
  assert.match(tested.verification[1]?.output ?? "", /auto-npm-coverage-ok/);
});

test("apply mode execution refuses to start from a dirty requester working tree", async () => {
  const cwd = await tempProject();
  await initGitRepo(cwd);

  const started = await startOrchestratedWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Add a generated module",
    backend: "codex",
    executionMode: "apply",
  }, async (input) => validRoleResult(input));
  await approveWorkflow({ cwd, runId: started.runId, gate: "requirements" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, async (input) => validRoleResult(input));
  await approveWorkflow({ cwd, runId: started.runId, gate: "architecture" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId }, async (input) => validRoleResult(input));
  await approveWorkflow({ cwd, runId: started.runId, gate: "implementation" });
  await writeFile(join(cwd, "README.md"), "# User has local edits\n");

  let executionCalled = false;
  const runner = async (input: RoleRunInput): Promise<RoleResult> => {
    executionCalled = input.phase === "execution";
    return validRoleResult(input);
  };

  await assert.rejects(
    () => continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner),
    /clean working tree/i,
  );
  assert.equal(executionCalled, false);
});

test("runShellCommand kills and reports a command that exceeds its timeout", async () => {
  const cwd = await tempProject();
  const result = await runShellCommand("sleep 10", cwd, 200);
  assert.equal(result.exitCode, 124);
  assert.match(result.output, /timed out after 200ms/);
});

test("runShellCommand captures exit code and output within the timeout", async () => {
  const cwd = await tempProject();
  const result = await runShellCommand("echo devcrew-ok", cwd, 5_000);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /devcrew-ok/);
});
