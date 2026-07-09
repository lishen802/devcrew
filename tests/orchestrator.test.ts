import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

import { approveWorkflow, rejectWorkflow, startWorkflow } from "../packages/core/src/index.js";
import {
  answerOrchestratedWorkflow,
  changedSinceBaseline,
  continueOrchestratedWorkflow,
  rejectOrchestratedWorkflow,
  revertChangedFiles,
  runShellCommand,
  startOrchestratedWorkflow,
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

test("apply mode records implementer changed files for gate review", async () => {
  const cwd = await tempProject();
  await initGitRepo(cwd);

  const started = await startOrchestratedWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Add a generated module",
    backend: "local",
    executionMode: "apply",
  });
  await approveWorkflow({ cwd, runId: started.runId, gate: "requirements" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId });
  await approveWorkflow({ cwd, runId: started.runId, gate: "architecture" });

  const runner = async (input: RoleRunInput): Promise<RoleResult> => {
    if (input.role === "implementer") {
      await writeFile(join(input.cwd, "generated.ts"), "export const generated = true;\n");
    }
    return {
      role: input.role,
      backend: input.backend,
      summary: `${input.role} completed`,
      markdown: `# ${input.role}\n\nDone.\n`,
      usedFallback: false,
    };
  };

  const implemented = await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);

  assert.deepEqual(implemented.changedFiles, ["?? generated.ts"]);
  const implementationPath = implemented.artifacts["implementation-plan"];
  assert.ok(implementationPath);
  const implementation = await readFile(implementationPath, "utf8");
  assert.match(implementation, /Recorded Changes/);
  assert.match(implementation, /\?\? generated\.ts/);
});

test("implementation phase writes an architecture compliance diff review", async () => {
  const cwd = await tempProject();
  await initGitRepo(cwd);

  const started = await startOrchestratedWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Update the README according to the approved architecture",
    backend: "local",
    executionMode: "apply",
  });
  await approveWorkflow({ cwd, runId: started.runId, gate: "requirements" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId });
  await approveWorkflow({ cwd, runId: started.runId, gate: "architecture" });

  const runner = async (input: RoleRunInput): Promise<RoleResult> => {
    if (input.role === "implementer") {
      await writeFile(join(input.cwd, "README.md"), "# Test Project\n\nImplemented architecture details.\n");
    }
    return {
      role: input.role,
      backend: input.backend,
      summary: `${input.role} completed`,
      markdown: `# ${input.role}\n\nDone.\n`,
      usedFallback: false,
    };
  };

  const implemented = await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);

  assert.ok(implemented.artifacts["implementation-review"]?.endsWith("implementation-review.md"));
  assert.match(implemented.implementationDiff, /Implemented architecture details/);
  const review = await readFile(implemented.artifacts["implementation-review"] ?? "", "utf8");
  assert.match(review, /Implementation Diff Review/);
  assert.match(review, /Architecture Compliance Inputs/);
  assert.match(review, /Architecture Artifact: present/);
  assert.match(review, /Changed Files: 1/);
  assert.match(review, /Captured Diff: present/);
  assert.match(review, /Architecture Compliance Review/);
  assert.match(review, /Needs Human Review/);
  assert.match(review, /M README\.md/);
  assert.match(review, /Implemented architecture details/);
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
      defaultBackend: "local",
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

  const started = await startOrchestratedWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Add verification evidence",
  });
  await approveWorkflow({ cwd, runId: started.runId, gate: "requirements" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId });
  await approveWorkflow({ cwd, runId: started.runId, gate: "architecture" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId });
  await approveWorkflow({ cwd, runId: started.runId, gate: "implementation" });

  const tested = await continueOrchestratedWorkflow({ cwd, runId: started.runId });

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
      defaultBackend: "local",
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

  const started = await startOrchestratedWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Discover verification commands",
  });
  await approveWorkflow({ cwd, runId: started.runId, gate: "requirements" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId });
  await approveWorkflow({ cwd, runId: started.runId, gate: "architecture" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId });
  await approveWorkflow({ cwd, runId: started.runId, gate: "implementation" });

  const tested = await continueOrchestratedWorkflow({ cwd, runId: started.runId });

  assert.deepEqual(tested.verification.map((result) => result.command), ["npm test", "npm run coverage"]);
  assert.equal(tested.verification[0]?.exitCode, 0);
  assert.match(tested.verification[0]?.output ?? "", /auto-npm-test-ok/);
  assert.equal(tested.verification[1]?.exitCode, 0);
  assert.match(tested.verification[1]?.output ?? "", /auto-npm-coverage-ok/);
});

test("apply mode implementation refuses to run on a dirty user working tree", async () => {
  const cwd = await tempProject();
  await initGitRepo(cwd);

  const started = await startOrchestratedWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Add a generated module",
    backend: "local",
    executionMode: "apply",
  });
  await approveWorkflow({ cwd, runId: started.runId, gate: "requirements" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId });
  await approveWorkflow({ cwd, runId: started.runId, gate: "architecture" });
  await writeFile(join(cwd, "README.md"), "# User has local edits\n");

  let runnerCalled = false;
  const runner = async (input: RoleRunInput): Promise<RoleResult> => {
    runnerCalled = true;
    return {
      role: input.role,
      backend: input.backend,
      summary: `${input.role} completed`,
      markdown: `# ${input.role}\n\nDone.\n`,
      usedFallback: false,
    };
  };

  await assert.rejects(
    () => continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner),
    /clean working tree.*README\.md/i,
  );
  assert.equal(runnerCalled, false);
});

test("changedSinceBaseline excludes pre-existing uncommitted edits", () => {
  const baseline = [" M existing.ts"];
  const current = [" M existing.ts", "?? generated.ts", " M src/app.ts"];
  assert.deepEqual(changedSinceBaseline(baseline, current), ["?? generated.ts", " M src/app.ts"]);
});

test("revertChangedFiles restores tracked files from HEAD and deletes untracked files", async () => {
  const gitCalls: string[][] = [];
  const removed: string[] = [];

  const runGit = async (args: string[]): Promise<{ exitCode: number; stdout: string }> => {
    gitCalls.push(args);
    if (args[0] === "cat-file") {
      // README.md exists in HEAD (tracked); generated.ts does not.
      return { exitCode: args[2] === "HEAD:README.md" ? 0 : 1, stdout: "" };
    }
    return { exitCode: 0, stdout: "" };
  };
  const removeFile = async (absolutePath: string): Promise<void> => {
    removed.push(absolutePath);
  };

  await revertChangedFiles("/repo", [" M README.md", "?? generated.ts"], { runGit, removeFile });

  // The tracked file is restored from HEAD via git restore.
  assert.ok(
    gitCalls.some(
      (args) => args[0] === "restore" && args[1] === "--source=HEAD" && args.at(-1) === "README.md",
    ),
    "expected a git restore --source=HEAD -- README.md call",
  );
  // The untracked file is deleted (never checked out).
  assert.ok(!gitCalls.some((args) => args[0] === "restore" && args.at(-1) === "generated.ts"));
  assert.equal(removed.length, 1);
  assert.match(removed[0], /generated\.ts$/);
});

test("revertChangedFiles uses the rename destination path", async () => {
  const gitCalls: string[][] = [];
  const runGit = async (args: string[]): Promise<{ exitCode: number; stdout: string }> => {
    gitCalls.push(args);
    return { exitCode: 0, stdout: "" };
  };

  await revertChangedFiles("/repo", ["R  old.ts -> new.ts"], { runGit, removeFile: async () => {} });

  assert.ok(gitCalls.some((args) => args[0] === "cat-file" && args[2] === "HEAD:new.ts"));
  assert.ok(gitCalls.some((args) => args[0] === "restore" && args.at(-1) === "new.ts"));
});

test("revertChangedFiles throws when restoring a tracked file fails", async () => {
  const runGit = async (args: string[]): Promise<{ exitCode: number; stdout: string }> => {
    if (args[0] === "cat-file") {
      return { exitCode: 0, stdout: "" };
    }
    return { exitCode: 128, stdout: "restore failed" };
  };

  await assert.rejects(
    () => revertChangedFiles("/repo", [" M README.md"], { runGit, removeFile: async () => {} }),
    /Failed to restore README\.md/,
  );
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

test("apply mode reject rolls back implementer edits to leave a clean tree", async () => {
  const cwd = await tempProject();
  await initGitRepo(cwd);

  const started = await startOrchestratedWorkflow({
    cwd,
    host: "codex",
    mode: "feature",
    request: "Add a generated module",
    backend: "local",
    executionMode: "apply",
  });
  await approveWorkflow({ cwd, runId: started.runId, gate: "requirements" });
  await continueOrchestratedWorkflow({ cwd, runId: started.runId });
  await approveWorkflow({ cwd, runId: started.runId, gate: "architecture" });

  const runner = async (input: RoleRunInput): Promise<RoleResult> => {
    if (input.role === "implementer") {
      await writeFile(join(input.cwd, "generated.ts"), "export const generated = true;\n");
      await writeFile(join(input.cwd, "README.md"), "# Overwritten by implementer\n");
    }
    return {
      role: input.role,
      backend: input.backend,
      summary: `${input.role} completed`,
      markdown: `# ${input.role}\n\nDone.\n`,
      usedFallback: false,
    };
  };

  const implemented = await continueOrchestratedWorkflow({ cwd, runId: started.runId }, runner);
  assert.deepEqual(implemented.changedFiles.sort(), [" M README.md", "?? generated.ts"].sort());

  const rejected = await rejectOrchestratedWorkflow({
    cwd,
    runId: started.runId,
    gate: "implementation",
    feedback: "Start over with a smaller change",
  });

  assert.deepEqual(rejected.changedFiles, []);
  // The newly created file is removed and the tracked file is restored to HEAD.
  await assert.rejects(() => readFile(join(cwd, "generated.ts"), "utf8"));
  assert.equal(await readFile(join(cwd, "README.md"), "utf8"), "# Test Project\n");
});
