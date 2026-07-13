import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { artifactPath } from "./paths.js";
import type { ArtifactName, ArtifactReadResult, RunState } from "./types.js";

function headingForArtifact(name: ArtifactName): string {
  return {
    requirements: "Requirements",
    architecture: "Architecture",
    "implementation-plan": "Implementation Plan",
    "implementation-review": "Implementation Review",
    "architecture-review": "Architecture Review",
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

function changedFilesBlock(state: RunState): string {
  if (state.changedFiles.length === 0) {
    return "No changed files were recorded.";
  }
  return state.changedFiles.map((file) => `- ${file}`).join("\n");
}

function verificationBlock(state: RunState): string {
  if (state.verification.length === 0) {
    return "No verification commands have been executed.";
  }
  return state.verification
    .map(
      (result) =>
        `### ${result.command}\n\nExit Code: ${result.exitCode}\n\nOutput:\n\n\`\`\`text\n${result.output || "(no output)"}\n\`\`\``,
    )
    .join("\n\n");
}

function verificationWaiverBlock(state: RunState): string {
  if (!state.verificationWaiver) {
    return "No verification waiver has been recorded.";
  }
  return `Reason: ${state.verificationWaiver.reason}\nRecorded At: ${state.verificationWaiver.createdAt}`;
}

function lintResultsBlock(state: RunState): string {
  if (state.lintResults.length === 0) {
    return "No lint or format commands have been executed.";
  }
  return state.lintResults
    .map(
      (result) =>
        `### ${result.command}\n\nExit Code: ${result.exitCode}\n\nOutput:\n\n\`\`\`text\n${result.output || "(no output)"}\n\`\`\``,
    )
    .join("\n\n");
}

function implementationDiffBlock(state: RunState): string {
  const diff = state.implementationDiff.trim();
  if (!diff) {
    return "No implementation diff was captured. Review the changed files list and repository state manually.";
  }
  return `\`\`\`diff\n${diff}\n\`\`\``;
}

function architectureComplianceInputsBlock(state: RunState): string {
  const architectureArtifact = state.artifacts.architecture ? "present" : "missing";
  const diffStatus = state.implementationDiff.trim() ? "present" : "missing";
  return [
    `- Architecture Artifact: ${architectureArtifact}${state.artifacts.architecture ? ` (${state.artifacts.architecture})` : ""}`,
    `- Changed Files: ${state.changedFiles.length}`,
    `- Captured Diff: ${diffStatus}`,
  ].join("\n");
}

function architectureComplianceStatus(state: RunState): string {
  if (state.changedFiles.length === 0 && !state.implementationDiff.trim()) {
    return "No implementation changes detected";
  }
  return "Needs Human Review";
}

export function renderArtifact(name: ArtifactName, state: RunState): string {
  const title = headingForArtifact(name);
  const common = `# ${title}\n\nRun: ${state.runId}\nMode: ${state.mode}\nExecution Mode: ${state.executionMode}\nExecution Policy: ${state.executionPolicy}\nVerification Status: ${state.verificationStatus}\nHost: ${state.host}\nBackend: ${state.backend}\nRequest: ${state.request}\n\n`;

  if (name === "requirements") {
    return `${common}## Functional Scope\n\n### In Scope\n\n- Capture the requested outcome in user-facing terms.\n\n### Out of Scope\n\n- Make explicit what is intentionally excluded before implementation.\n\n## Users and Scenarios\n\n- Identify the primary users and their key scenarios.\n\n## Acceptance Criteria\n\n- Express each criterion as Given / When / Then so it stays testable.\n\n## Priorities\n\n- Classify each requirement as Must / Should / Could / Won't (MoSCoW).\n\n## Current Requester Answers\n\n${answerBlock(state)}\n\n## Discovered Standards\n\n${standardsExcerpt(state)}\n\n## Open Questions\n\n- Confirm primary users and success criteria.\n- Confirm scope boundaries and non-goals.\n- Confirm deployment or environment constraints.\n\n## Rejection Feedback\n\n${feedbackBlock(state)}\n`;
  }

  if (name === "architecture") {
    return `${common}${workflowContextBlock(state)}\n## Technical Decisions\n\nFor each key decision record Decision, Options Considered, Choice, Rationale, and Trade-offs.\n\n- Decision: owns state transitions, gates, and MCP tool handlers via a workflow service.\n  - Options Considered: monolithic handler vs. layered service + adapters.\n  - Choice: layered workflow service with a host adapter and artifact writer.\n  - Rationale: keeps gate logic testable and host execution swappable.\n  - Trade-offs: more modules to wire, but clearer boundaries.\n\n## Interface Contracts\n\nFor each interface give the signature, request/response schema, error contract, and data model.\n\n- Host adapter: selects Codex or Claude execution based on host or config override.\n- Artifact writer: persists Markdown outputs under docs/devcrew for review.\n\n## Data Flow and Deployment\n\n- Record data flow, deployment expectations, and rollback considerations.\n- For greenfield workflows keep the first implementation small enough to ship and test end to end.\n\n## Architecture Review Checklist\n\n- Architecture traces directly to approved requirements.\n- Implementation can be tested without a live production integration.\n- Security and permission decisions remain delegated to the host agent runtime.\n`;
  }

  if (name === "implementation-plan") {
    return `${common}${workflowContextBlock(state)}\n## Implementation Summary\n\nImplement the smallest code path that satisfies the approved architecture.\n\n## Implementation Tasks\n\n1. Update or create focused tests for the requested behavior.\n2. Implement the smallest code path that satisfies the approved architecture.\n3. Preserve discovered standards and existing repository conventions.\n4. Write or update user-facing docs for changed behavior.\n5. Run the project validation commands and capture evidence.\n\n## Recorded Changes\n\n${changedFilesBlock(state)}\n\n## Lint Results\n\n${lintResultsBlock(state)}\n\n## Code Review Criteria\n\n- Changes stay inside the approved scope.\n- Public interfaces match the architecture artifact.\n- Tests cover success, failure, and gate behavior where applicable.\n`;
  }

  if (name === "implementation-review") {
    return `${common}${workflowContextBlock(state)}\n## Implementation Diff Review\n\n### Changed Files\n\n${changedFilesBlock(state)}\n\n### Captured Diff\n\n${implementationDiffBlock(state)}\n\n## Lint Results\n\n${lintResultsBlock(state)}\n\n## Architecture Compliance Inputs\n\n${architectureComplianceInputsBlock(state)}\n\n## Architecture Compliance Review\n\nStatus: ${architectureComplianceStatus(state)}\n\n- Confirm changed files map back to the approved architecture artifact.\n- Confirm public interfaces, data flow, and deployment assumptions remain consistent with the architecture.\n- Confirm implementation scope does not include unapproved requirements or unrelated refactors.\n- Record any mismatch as rejection feedback before approving the implementation gate.\n`;
  }

  if (name === "architecture-review") {
    return `${common}${workflowContextBlock(state)}\n## Technical Decisions\n\nReview the captured implementation diff against the approved architecture. State whether the implementation keeps its approved interfaces, data flow, deployment, and rollback assumptions.\n\n## Interface Contracts\n\nIdentify each changed public interface and whether it conforms to the approved architecture artifact.\n\n## Data Flow and Deployment\n\nReview the implementation diff for data-flow, deployment, migration, and rollback deviations.\n\n## Architecture Review Checklist\n\n- Review the captured implementation diff and changed-files list.\n- Trace each material change to an approved architectural decision.\n- Record any mismatch as rejection feedback before the testing phase begins.\n`;
  }

  if (name === "test-report") {
    return `${common}${workflowContextBlock(state)}\n## Test Cases\n\nEnumerate cases as a table covering happy, edge, failure, and regression paths.\n\n| ID | Scenario | Type | Expected |\n| --- | --- | --- | --- |\n| TC-1 | Primary success path | happy | Behaves as specified |\n| TC-2 | Boundary input | edge | Handled without error |\n| TC-3 | Invalid input | failure | Fails safely with clear error |\n\n## Coverage\n\nRun the coverage command and report the coverage summary plus any gaps. Evidence is captured under Acceptance Evidence.\n\n## Acceptance Evidence\n\n${verificationBlock(state)}\n\n## Verification Waiver\n\n${verificationWaiverBlock(state)}\n\n## Known Risks\n\n- Headless SDK capabilities are governed by the recorded DevCrew execution policy.\n- Interactive-host work is performed through the host's native agent controls.\n`;
  }

  return `${common}${workflowContextBlock(state)}\n## Acceptance Summary\n\nThe requester approved requirements, architecture, implementation planning, and test reporting gates for this run.\n\n## Verification Waiver\n\n${verificationWaiverBlock(state)}\n\n## Approved Gates\n\n${Object.entries(state.gates)
    .map(([gate, status]) => `- ${gate}: ${status}`)
    .join("\n")}\n`;
}

export async function writeArtifact(name: ArtifactName, state: RunState): Promise<string> {
  const path = artifactPath(state.cwd, state.runId, name, state.artifactDirectory);
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
