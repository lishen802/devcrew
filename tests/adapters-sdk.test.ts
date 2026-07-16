import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  buildClaudeOptions,
  buildCodexThreadOptions,
  extractClaudeResult,
  extractCodexText,
  runRole,
  type ClaudeMessage,
  type ClaudeQueryOptions,
  type CodexThreadOptions,
  type ModuleLoader,
  type RoleRunInput,
} from "../packages/adapters/src/index.js";

const baseInput: Omit<RoleRunInput, "backend"> = {
  role: "architect",
  phase: "architecture",
  request: "Add billing export",
  mode: "feature",
  cwd: "/tmp/project",
  standards: "Use TypeScript strict mode.",
  artifactPath: "docs/devcrew/dc-demo/architecture.md",
};

const architectureMarkdown = [
  "# Architecture",
  "",
  "## Technical Decisions",
  "",
  "Use the existing service boundary.",
  "",
  "## Interface Contracts",
  "",
  "Expose a focused workflow API.",
  "",
  "## Data Flow and Deployment",
  "",
  "Persist artifacts locally.",
  "",
  "## Architecture Review Checklist",
  "",
  "- Trace decisions to requirements.",
].join("\n");

const implementationMarkdown = [
  "# Implementation Plan",
  "",
  "## Implementation Summary",
  "",
  "Make the smallest approved change.",
  "",
  "## Standards Compliance",
  "",
  "Run lint and tests.",
  "",
  "## Changed Files",
  "",
  "- generated.ts",
  "",
  "## Tests Added or Updated",
  "",
  "- tests cover the change.",
].join("\n");

const testReportMarkdown = [
  "# Test Report",
  "",
  "## Test Cases",
  "",
  "| ID | Scenario | Type | Expected |",
  "| --- | --- | --- | --- |",
  "| TC-1 | Primary path | happy | Passes |",
  "",
  "## Coverage",
  "",
  "Coverage command executed.",
  "",
  "## Verification Evidence",
  "",
  "npm test exited 0.",
  "",
  "## Known Risks",
  "",
  "No known residual risk.",
].join("\n");

// --- Pure contract helpers --------------------------------------------------

test("buildCodexThreadOptions pins the read-only sandbox contract", () => {
  const options = buildCodexThreadOptions("/tmp/project");
  assert.deepEqual(options, {
    workingDirectory: "/tmp/project",
    skipGitRepoCheck: true,
    sandboxMode: "read-only",
  });
});

test("buildCodexThreadOptions can request a writable sandbox for apply mode", () => {
  const options = buildCodexThreadOptions("/tmp/project", "workspace-write");
  assert.equal(options.sandboxMode, "workspace-write");
});

test("buildCodexThreadOptions leaves writable sandbox approval to the host", () => {
  const options = buildCodexThreadOptions("/tmp/project", "workspace-write");
  assert.equal(options.approvalPolicy, undefined);
  assert.equal(options.networkAccessEnabled, undefined);
});

test("buildCodexThreadOptions leaves read-only runs without an approval override", () => {
  const options = buildCodexThreadOptions("/tmp/project");
  assert.equal(options.approvalPolicy, undefined);
});

test("runRole gives implementer a writable Codex sandbox only during execution", async () => {
  const receivedOptions: CodexThreadOptions[] = [];
  const receivedPrompts: string[] = [];

  const loadModule: ModuleLoader = async () => ({
    Codex: class {
      startThread(options?: CodexThreadOptions) {
        receivedOptions.push(options ?? {});
        return {
          run: async (prompt: string) => {
            receivedPrompts.push(prompt);
            return { finalResponse: implementationMarkdown, items: [], usage: null };
          },
        };
      }
    },
  });

  const planned = await runRole({
    ...baseInput,
    backend: "codex",
    role: "implementer",
    phase: "implementation",
    executionMode: "apply",
  }, { loadModule });
  const executed = await runRole({
    ...baseInput,
    backend: "codex",
    role: "implementer",
    phase: "execution",
    executionMode: "apply",
    executionPolicy: "headless-restricted",
  }, { loadModule });

  assert.equal(planned.usedFallback, false);
  assert.equal(executed.usedFallback, false);
  assert.equal(receivedOptions[0]?.sandboxMode, "read-only");
  assert.match(receivedPrompts[0] ?? "", /Do not modify repository files/);
  assert.equal(receivedOptions[1]?.sandboxMode, "workspace-write");
  assert.equal(receivedOptions[1]?.approvalPolicy, "on-request");
  assert.equal(receivedOptions[1]?.networkAccessEnabled, false);
  assert.match(receivedPrompts[1] ?? "", /You may modify repository files/);
});

test("extractCodexText returns the trimmed finalResponse", () => {
  assert.equal(extractCodexText({ finalResponse: "  # Architecture\n" }), "# Architecture");
});

test("extractCodexText throws when the turn has no usable finalResponse", () => {
  assert.throws(() => extractCodexText({ finalResponse: "" }), /empty finalResponse/);
  assert.throws(() => extractCodexText(undefined), /empty finalResponse/);
});

test("buildClaudeOptions pins the read-only planning contract", () => {
  assert.deepEqual(buildClaudeOptions("/tmp/project"), {
    cwd: "/tmp/project",
    permissionMode: "plan",
    allowedTools: ["Read", "Grep", "Glob"],
  });
});

test("runRole gives a restricted Claude tester no shell auto-approval", async () => {
  let receivedOptions: ClaudeQueryOptions | undefined;
  let receivedPrompt = "";

  const loadModule: ModuleLoader = async () => ({
    query: ({ prompt, options }: { prompt: string; options?: ClaudeQueryOptions }): AsyncIterable<ClaudeMessage> => {
      receivedPrompt = prompt;
      receivedOptions = options;
      async function* stream(): AsyncGenerator<ClaudeMessage> {
        yield { type: "result", subtype: "success", result: testReportMarkdown, is_error: false };
      }
      return stream();
    },
  });

  const result = await runRole({
    ...baseInput,
    backend: "claude",
    role: "tester",
    phase: "testing",
    executionMode: "apply",
    executionPolicy: "headless-restricted",
  }, { loadModule });

  assert.equal(result.usedFallback, false);
  assert.equal(receivedOptions?.permissionMode, "dontAsk");
  assert.deepEqual(receivedOptions?.allowedTools, ["Read", "Grep", "Glob"]);
  assert.equal(receivedOptions?.allowedTools?.includes("Bash"), false);
  assert.match(receivedPrompt, /report exact evidence/i);
});

test("runRole rejects interactive-host execution before loading an SDK", async () => {
  let loaded = false;
  const loadModule: ModuleLoader = async () => {
    loaded = true;
    return {};
  };

  await assert.rejects(
    () =>
      runRole({
        ...baseInput,
        backend: "claude",
        role: "implementer",
        phase: "execution",
        executionMode: "apply",
        executionPolicy: "interactive-host",
      }, { loadModule }),
    /interactive-host execution must be performed by the host/i,
  );
  assert.equal(loaded, false);
});

test("extractClaudeResult returns the result on a successful turn", () => {
  assert.equal(
    extractClaudeResult({ type: "result", subtype: "success", result: "  # Architecture\n", is_error: false }),
    "# Architecture",
  );
});

test("extractClaudeResult surfaces the real failure subtype", () => {
  assert.throws(
    () => extractClaudeResult({ type: "result", subtype: "error_max_turns", is_error: true }),
    /error_max_turns/,
  );
  assert.throws(() => extractClaudeResult(undefined), /did not return a result message/);
});

// --- runRole wiring with an injected fake SDK module ------------------------

test("runRole drives the Codex SDK through the host executable with pinned thread options", async () => {
  const pathRoot = await mkdtemp(join(tmpdir(), "devcrew-host-codex-"));
  const sdkBinDirectory = join(pathRoot, "node_modules", ".bin");
  const hostBinDirectory = join(pathRoot, "host", "bin");
  await Promise.all([
    mkdir(sdkBinDirectory, { recursive: true }),
    mkdir(hostBinDirectory, { recursive: true }),
  ]);
  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  const sdkCodexPath = join(sdkBinDirectory, executableName);
  const codexPath = join(hostBinDirectory, executableName);
  await writeFile(sdkCodexPath, "sdk codex placeholder");
  await writeFile(codexPath, "host codex placeholder");
  await Promise.all([chmod(sdkCodexPath, 0o755), chmod(codexPath, 0o755)]);

  const originalPath = process.env.PATH;
  process.env.PATH = `${sdkBinDirectory}${delimiter}${hostBinDirectory}`;
  let receivedClientOptions: { codexPathOverride?: string } | undefined;
  let receivedOptions: CodexThreadOptions | undefined;
  let receivedPrompt = "";

  const loadModule: ModuleLoader = async (specifier) => {
    assert.equal(specifier, "@openai/codex-sdk");
    return {
      Codex: class {
        constructor(options?: { codexPathOverride?: string }) {
          receivedClientOptions = options;
        }

        startThread(options?: CodexThreadOptions) {
          receivedOptions = options;
          return {
            run: async (prompt: string) => {
              receivedPrompt = prompt;
              return { finalResponse: `${architectureMarkdown}\n\nReal SDK output.`, items: [], usage: null };
            },
          };
        }
      },
    };
  };

  try {
    const result = await runRole({ ...baseInput, backend: "codex" }, { loadModule });

    assert.equal(result.usedFallback, false);
    assert.equal(result.backend, "codex");
    assert.match(result.markdown, /Real SDK output/);
    assert.deepEqual(receivedClientOptions, { codexPathOverride: codexPath });
    assert.deepEqual(receivedOptions, {
      workingDirectory: "/tmp/project",
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
    });
    assert.match(receivedPrompt, /Add billing export/);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(pathRoot, { recursive: true, force: true });
  }
});

test("runRole falls back with a clear reason when the Codex turn is empty", async () => {
  const loadModule: ModuleLoader = async () => ({
    Codex: class {
      startThread() {
        return { run: async () => ({ finalResponse: "" }) };
      }
    },
  });

  const result = await runRole({ ...baseInput, backend: "codex" }, { loadModule });

  assert.equal(result.usedFallback, true);
  assert.match(result.summary, /empty finalResponse/);
});

test("runRole drives the Claude SDK with the pinned query options and returns the result", async () => {
  let receivedOptions: ClaudeQueryOptions | undefined;

  const loadModule: ModuleLoader = async (specifier) => {
    assert.equal(specifier, "@anthropic-ai/claude-agent-sdk");
    return {
      query: ({ options }: { prompt: string; options?: ClaudeQueryOptions }): AsyncIterable<ClaudeMessage> => {
        receivedOptions = options;
        async function* stream(): AsyncGenerator<ClaudeMessage> {
          yield { type: "assistant" };
          yield { type: "result", subtype: "success", result: `${architectureMarkdown}\n\nClaude output.`, is_error: false };
        }
        return stream();
      },
    };
  };

  const result = await runRole({ ...baseInput, backend: "claude" }, { loadModule });

  assert.equal(result.usedFallback, false);
  assert.equal(result.backend, "claude");
  assert.match(result.markdown, /Claude output/);
  assert.deepEqual(receivedOptions, {
    cwd: "/tmp/project",
    permissionMode: "plan",
    allowedTools: ["Read", "Grep", "Glob"],
  });
});

test("runRole falls back with the failure subtype when Claude ends in error", async () => {
  const loadModule: ModuleLoader = async () => ({
    query: (): AsyncIterable<ClaudeMessage> => {
      async function* stream(): AsyncGenerator<ClaudeMessage> {
        yield { type: "result", subtype: "error_during_execution", is_error: true };
      }
      return stream();
    },
  });

  const result = await runRole({ ...baseInput, backend: "claude" }, { loadModule });

  assert.equal(result.usedFallback, true);
  assert.match(result.summary, /error_during_execution/);
});
