import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { artifactPath } from "./paths.js";
import type { ArtifactName, ArtifactReadResult, RunState } from "./types.js";

function headingForArtifact(name: ArtifactName): string {
  return {
    requirements: "Requirements",
    architecture: "Architecture",
    "implementation-plan": "Implementation Plan",
    "test-report": "Test Report",
    acceptance: "Acceptance",
  }[name];
}

function standardsExcerpt(state: RunState): string {
  const excerpt = state.standards.combined.trim();
  if (excerpt.length <= 1400) {
    return excerpt;
  }
  return `${excerpt.slice(0, 1400).trim()}\n\n[Standards truncated in artifact. Full sources: ${state.standards.sources.join(", ")}]`;
}

function answerBlock(state: RunState): string {
  if (state.answers.length === 0) {
    return "No requester answers have been recorded yet.";
  }
  return state.answers.map((answer, index) => `${index + 1}. ${answer.answer}`).join("\n");
}

function feedbackBlock(state: RunState): string {
  if (state.feedback.length === 0) {
    return "No rejection feedback has been recorded.";
  }
  return state.feedback.map((feedback) => `- ${feedback.gate}: ${feedback.message}`).join("\n");
}

function workflowContextBlock(state: RunState): string {
  return `## Workflow Context\n\n### Requester Answers\n\n${answerBlock(state)}\n\n### Rejection Feedback\n\n${feedbackBlock(state)}\n`;
}

export function renderArtifact(name: ArtifactName, state: RunState): string {
  const title = headingForArtifact(name);
  const common = `# ${title}\n\nRun: ${state.runId}\nMode: ${state.mode}\nHost: ${state.host}\nBackend: ${state.backend}\nRequest: ${state.request}\n\n`;

  if (name === "requirements") {
    return `${common}## Product Boundary\n\n- Capture the requested outcome in user-facing terms.\n- Make explicit what is in scope and out of scope before implementation.\n- Treat the requester as the final approver for this stage.\n\n## Current Requester Answers\n\n${answerBlock(state)}\n\n## Discovered Standards\n\n${standardsExcerpt(state)}\n\n## Open Clarifications\n\n- Confirm primary users and success criteria.\n- Confirm scope boundaries and non-goals.\n- Confirm deployment or environment constraints.\n\n## Rejection Feedback\n\n${feedbackBlock(state)}\n`;
  }

  if (name === "architecture") {
    return `${common}${workflowContextBlock(state)}\n## Technical Architecture\n\n- Use the repository's existing language, framework, and module boundaries when this is a feature workflow.\n- For greenfield workflows, keep the first implementation small enough to ship and test end to end.\n- Record data flow, interfaces, deployment expectations, and rollback considerations.\n\n## Proposed Components\n\n- Workflow service: owns state transitions, gates, and MCP tool handlers.\n- Host adapter: selects Codex or Claude execution based on the current host or config override.\n- Artifact writer: persists Markdown outputs under docs/devcrew for review.\n\n## Review Checklist\n\n- Architecture traces directly to approved requirements.\n- Implementation can be tested without a live production integration.\n- Security and permission decisions remain delegated to the host agent runtime.\n`;
  }

  if (name === "implementation-plan") {
    return `${common}${workflowContextBlock(state)}\n## Implementation Tasks\n\n1. Update or create focused tests for the requested behavior.\n2. Implement the smallest code path that satisfies the approved architecture.\n3. Preserve discovered standards and existing repository conventions.\n4. Write or update user-facing docs for changed behavior.\n5. Run the project validation commands and capture evidence.\n\n## Code Review Criteria\n\n- Changes stay inside the approved scope.\n- Public interfaces match the architecture artifact.\n- Tests cover success, failure, and gate behavior where applicable.\n`;
  }

  if (name === "test-report") {
    return `${common}${workflowContextBlock(state)}\n## Test Report\n\n## Planned Verification\n\n- Run unit tests for changed modules.\n- Run integration or MCP contract checks when tool behavior changes.\n- Run build or typecheck before completion.\n\n## Acceptance Evidence\n\nRecord exact commands, exit codes, and important output here after execution.\n\n## Known Risks\n\n- Host SDK availability may vary by user environment.\n- Agent permissions are inherited from the host and must be reviewed there.\n`;
  }

  return `${common}${workflowContextBlock(state)}\n## Acceptance Summary\n\nThe requester approved requirements, architecture, implementation planning, and test reporting gates for this run.\n\n## Approved Gates\n\n${Object.entries(state.gates)
    .map(([gate, status]) => `- ${gate}: ${status}`)
    .join("\n")}\n`;
}

export async function writeArtifact(name: ArtifactName, state: RunState): Promise<string> {
  const path = artifactPath(state.cwd, state.runId, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderArtifact(name, state), "utf8");
  return path;
}

export async function readArtifact(state: RunState, name: ArtifactName): Promise<ArtifactReadResult> {
  const path = state.artifacts[name];
  if (!path) {
    throw new Error(`Artifact ${name} has not been created for run ${state.runId}`);
  }
  const content = await readFile(path, "utf8");
  return {
    name,
    path,
    content,
    summary: content.split("\n").slice(0, 8).join("\n"),
  };
}
