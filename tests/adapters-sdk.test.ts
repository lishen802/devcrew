import test from "node:test";
import assert from "node:assert/strict";

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

test("runRole gives implementer a writable Codex sandbox only in apply mode", async () => {
  let receivedOptions: CodexThreadOptions | undefined;
  let receivedPrompt = "";

  const loadModule: ModuleLoader = async () => ({
    Codex: class {
      startThread(options?: CodexThreadOptions) {
        receivedOptions = options;
        return {
          run: async (prompt: string) => {
            receivedPrompt = prompt;
            return { finalResponse: "# Implementation\n\nChanged files.", items: [], usage: null };
          },
        };
      }
    },
  });

  const result = await runRole({
    ...baseInput,
    backend: "codex",
    role: "implementer",
    phase: "implementation",
    executionMode: "apply",
  }, { loadModule });

  assert.equal(result.usedFallback, false);
  assert.equal(receivedOptions?.sandboxMode, "workspace-write");
  assert.doesNotMatch(receivedPrompt, /Do not modify repository files/);
  assert.match(receivedPrompt, /You may modify repository files/);
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

test("runRole gives tester Bash access through Claude only in apply mode", async () => {
  let receivedOptions: ClaudeQueryOptions | undefined;
  let receivedPrompt = "";

  const loadModule: ModuleLoader = async () => ({
    query: ({ prompt, options }: { prompt: string; options?: ClaudeQueryOptions }): AsyncIterable<ClaudeMessage> => {
      receivedPrompt = prompt;
      receivedOptions = options;
      async function* stream(): AsyncGenerator<ClaudeMessage> {
        yield { type: "result", subtype: "success", result: "# Test Report\n\nExecuted tests.", is_error: false };
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
  }, { loadModule });

  assert.equal(result.usedFallback, false);
  assert.equal(receivedOptions?.permissionMode, "acceptEdits");
  assert.deepEqual(receivedOptions?.allowedTools, ["Read", "Grep", "Glob", "Bash"]);
  assert.match(receivedPrompt, /run validation commands/i);
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

test("runRole drives the Codex SDK with the pinned thread options and returns finalResponse", async () => {
  let receivedOptions: CodexThreadOptions | undefined;
  let receivedPrompt = "";

  const loadModule: ModuleLoader = async (specifier) => {
    assert.equal(specifier, "@openai/codex-sdk");
    return {
      Codex: class {
        startThread(options?: CodexThreadOptions) {
          receivedOptions = options;
          return {
            run: async (prompt: string) => {
              receivedPrompt = prompt;
              return { finalResponse: "# Architecture\n\nReal SDK output.", items: [], usage: null };
            },
          };
        }
      },
    };
  };

  const result = await runRole({ ...baseInput, backend: "codex" }, { loadModule });

  assert.equal(result.usedFallback, false);
  assert.equal(result.backend, "codex");
  assert.match(result.markdown, /Real SDK output/);
  assert.deepEqual(receivedOptions, {
    workingDirectory: "/tmp/project",
    skipGitRepoCheck: true,
    sandboxMode: "read-only",
  });
  assert.match(receivedPrompt, /Add billing export/);
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
          yield { type: "result", subtype: "success", result: "# Architecture\n\nClaude output.", is_error: false };
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
