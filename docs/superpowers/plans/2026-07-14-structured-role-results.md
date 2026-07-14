# Structured Role Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept validated, versioned role-result envelopes while preserving Markdown-only SDK outputs and expose structured evidence through run state, artifacts, and MCP.

**Architecture:** The core package owns envelope types and state migration. The adapter recognizes one explicitly marked JSON block, validates role-specific data, and returns Markdown with the protocol block removed. The orchestrator uses the normalized result without changing gates; artifacts render a human-readable appendix, and MCP continues returning the persisted state.

**Tech Stack:** TypeScript strict mode, Node.js built-in test runner, `tsx`.

---

### Task 1: Define normalized envelope types and old-state migration

**Files:**
- Modify: `packages/core/src/types.ts:91-100`
- Modify: `packages/core/src/store.ts:24-70`
- Test: `tests/core.test.ts`

- [ ] **Step 1: Write the failing migration test**

Append this test to `tests/core.test.ts`:

```ts
test("loadState marks pre-envelope role results as legacy", async () => {
  const cwd = await tempProject();
  const started = await startWorkflow({ cwd, host: "codex", mode: "feature", request: "Migrate roles" });
  const path = runDir(cwd, started.runId);
  const raw = JSON.parse(await readFile(join(path, "state.json"), "utf8")) as Record<string, unknown>;
  raw.roles = [{ role: "pm", backend: "codex", summary: "old", markdown: "# Old", usedFallback: false }];
  await writeFile(join(path, "state.json"), JSON.stringify(raw));

  const role = (await loadState(cwd, started.runId)).roles[0] as unknown as { format?: string };
  assert.equal(role.format, "legacy");
});
```

- [ ] **Step 2: Verify it fails**

Run: `npm test -- --test-name-pattern="pre-envelope role"`

Expected: FAIL because `RoleResult.format` does not exist.

- [ ] **Step 3: Add the smallest normalized types and migration**

Add these exports in `packages/core/src/types.ts` and make `format` mandatory on `RoleResult`:

```ts
export interface CommandEvidence {
  command: string;
  exitCode: number;
  output?: string;
}

export interface RoleQuestion {
  id: string;
  prompt: string;
  context?: string;
}

export interface StructuredRoleData {
  schemaVersion: 1;
  role: Exclude<RoleResult["role"], "conductor">;
  summary: string;
  risks: string[];
  evidence: CommandEvidence[];
  questions?: RoleQuestion[];
  decisions?: string[];
  reviewDecision?: ArchitectureReviewDecision;
  changedFiles?: string[];
  testCases?: Array<{ id: string; scenario: string; type: "happy" | "edge" | "failure" | "regression"; expected: string }>;
}
```

In `loadState`, map each persisted role missing a valid `format` to `{ ...role, format: "legacy" }`, leaving all prior persisted fields intact.

- [ ] **Step 4: Verify it passes**

Run: `npm test -- --test-name-pattern="pre-envelope role"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/store.ts tests/core.test.ts
git commit -m "feat: normalize persisted role results"
```

### Task 2: Parse and validate the marked envelope in adapters

**Files:**
- Modify: `packages/adapters/src/index.ts:69-102,143-162,424-459`
- Test: `tests/adapters.test.ts`

- [ ] **Step 1: Write failing parser tests**

Export `parseRoleResultOutput` and add tests that call it with this valid PM output and each invalid variation:

```ts
const output = `<!-- devcrew-role-result -->
\`\`\`json
{"schemaVersion":1,"role":"pm","summary":"Need scope","risks":[],"evidence":[],"questions":[{"id":"format","prompt":"Which formats?"}]}
\`\`\`
# Requirements

## Functional Scope
`;
const result = parseRoleResultOutput("pm", "requirements", output);
assert.equal(result.format, "structured");
assert.deepEqual(result.questions, ["Which formats?"]);
assert.doesNotMatch(result.markdown, /devcrew-role-result/);
```

Add separate `assert.throws` tests for malformed marked JSON, two marked blocks, `schemaVersion: 2`, role mismatch, duplicate/blank PM question IDs, and a non-integer command exit code. Add a Markdown-only test proving `format === "legacy"` and existing PM/review parsing remain unchanged.

- [ ] **Step 2: Verify they fail**

Run: `npm test -- --test-name-pattern="role result output"`

Expected: FAIL because `parseRoleResultOutput` is not exported.

- [ ] **Step 3: Implement the protocol parser and prompt contract**

Implement a parser that finds exactly one `<!-- devcrew-role-result -->` followed by a `json` fenced block. When no marker exists, return the original Markdown and `format: "legacy"`; when a marker exists, reject malformed or invalid data. Require all common fields, role-matching field sets, unique PM question IDs, nonempty strings, and integer command exit codes. Return the Markdown with only the marked block removed.

Add this exact prompt guidance before `Required Sections`:

```ts
"Return this protocol block first:",
"<!-- devcrew-role-result -->",
"```json",
"{\"schemaVersion\":1,\"role\":\"<current role>\",\"summary\":\"...\",\"risks\":[],\"evidence\":[]}",
"```",
"Then return the required Markdown H2 sections. Do not include a second marked result block.",
```

Replace direct Markdown extraction in `runRole` with the parser's normalized result. For legacy output, keep `extractOpenQuestions` and `extractArchitectureReviewDecision`; for structured output, derive those compatibility fields from validated structured data.

- [ ] **Step 4: Verify adapter tests pass**

Run: `npm test -- tests/adapters.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/index.ts tests/adapters.test.ts
git commit -m "feat: parse structured role result envelopes"
```

### Task 3: Persist and render structured implementation and test evidence

**Files:**
- Modify: `packages/orchestrator/src/index.ts:317-344,456-481`
- Test: `tests/orchestrator.test.ts`

- [ ] **Step 1: Write failing workflow tests**

Add a structured PM runner result with a question and assert `awaiting_input`. Add an implementation result with `format: "structured"` and `structured.changedFiles` plus command evidence, then assert the persisted role retains them and `implementation-review.md` contains `## Structured Role Result` and the command/exit code. Add an analogous tester assertion for `test-report.md` risks and evidence.

- [ ] **Step 2: Verify they fail**

Run: `npm test -- --test-name-pattern="structured (PM|implementation|tester)"`

Expected: FAIL because artifacts do not render structured role data.

- [ ] **Step 3: Render the structured appendix without changing workflow evidence sources**

Add an orchestrator artifact helper used by `appendExecutionSections` that renders `state.roles.at(-1)?.structured` only when `format === "structured"`. It must show schema version, summary, changed files, command evidence, test cases, risks, and questions when present, escaping no data and preserving the role's Markdown body as the primary artifact.

Keep the existing captured Git diff and configured verification as authoritative promotion evidence. Structured implementation `changedFiles` and tester commands are supplemental role assertions, not a way to overwrite `state.changedFiles`, `state.implementationDiff`, or `state.verification`.

In the orchestrator, use structured PM question prompts for `pendingQuestions` and structured review decisions for `architectureReview`; preserve the existing compatibility fields so legacy runners and callers continue to work.

- [ ] **Step 4: Verify workflow tests pass**

Run: `npm test -- tests/orchestrator.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/index.ts tests/orchestrator.test.ts
git commit -m "feat: render structured role evidence"
```

### Task 4: Surface format and results through MCP and complete regression checks

**Files:**
- Modify: `packages/service/src/tools.ts:215-320`
- Test: `tests/service.test.ts`
- Modify: `docs/codex.md`
- Modify: `docs/claude-code.md`

- [ ] **Step 1: Write the failing MCP test**

Start a workflow with a structured PM runner, invoke `devcrew_status`, and assert its text includes `role_format=structured` plus `structuredContent.state.roles.at(-1).structured.questions[0].id === "format"`. The test must use `callDevCrewTool`, not inspect the state file directly.

- [ ] **Step 2: Verify it fails**

Run: `npm test -- --test-name-pattern="MCP.*structured role"`

Expected: FAIL until the state summary exposes the normalized role format.

- [ ] **Step 3: Keep MCP state safe and document the migration**

Return the existing state object unchanged except for its newly persisted normalized role fields; do not create a second incompatible tool response shape. Extend `summarizeState` with `role_format=<legacy|structured|none>`.

Document the marker, schema version, legacy fallback rule, and the rule that malformed marked output is rejected rather than downgraded in both host guides.

- [ ] **Step 4: Verify the focused service test passes**

Run: `npm test -- tests/service.test.ts`

Expected: PASS.

- [ ] **Step 5: Run complete validation and inspect the patch**

Run: `npm run validate && npm test && git diff main...HEAD --check`

Expected: validation and all tests pass; whitespace check prints no output.

- [ ] **Step 6: Commit**

```bash
git add packages/service/src/tools.ts tests/service.test.ts docs/codex.md docs/claude-code.md
git commit -m "docs: describe structured role result migration"
```
