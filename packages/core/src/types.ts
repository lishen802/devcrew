export const WORKFLOW_MODES = ["feature", "greenfield"] as const;
export const EXECUTION_MODES = ["plan", "apply"] as const;
export const EXECUTION_POLICIES = ["interactive-host", "headless-restricted", "headless-unattended"] as const;
export const HOSTS = ["codex", "claude"] as const;
export const BACKENDS = ["codex", "claude", "local"] as const;
export const PHASES = [
  "requirements",
  "architecture",
  "implementation",
  "execution",
  "review",
  "testing",
  "acceptance",
  "complete",
] as const;
export const GATES = ["requirements", "architecture", "implementation", "implementation-review", "testing"] as const;
export const ARTIFACTS = [
  "requirements",
  "architecture",
  "implementation-plan",
  "implementation-review",
  "architecture-review",
  "test-report",
  "acceptance",
] as const;

export type WorkflowMode = (typeof WORKFLOW_MODES)[number];
export type ExecutionMode = (typeof EXECUTION_MODES)[number];
export type ExecutionPolicy = (typeof EXECUTION_POLICIES)[number];
export type VerificationStatus = "not_run" | "passed" | "failed";
export type Host = (typeof HOSTS)[number];
export type BackendName = (typeof BACKENDS)[number];
export type Phase = (typeof PHASES)[number];
export type GateName = (typeof GATES)[number];
export type ArtifactName = (typeof ARTIFACTS)[number];
export type GateStatus = "not_started" | "pending" | "approved" | "rejected";
export type RunStatus = "ready" | "awaiting_input" | "awaiting_approval" | "awaiting_execution" | "complete";

export interface RoleSection {
  heading: string;
  description: string;
}

export const ROLE_SECTIONS: Record<Exclude<RoleResult["role"], "conductor">, RoleSection[]> = {
  pm: [
    { heading: "Functional Scope", description: "explicit In Scope and Out of Scope lists" },
    { heading: "Users and Scenarios", description: "primary users and their key scenarios" },
    { heading: "Acceptance Criteria", description: "testable criteria written as Given / When / Then" },
    { heading: "Priorities", description: "classify each requirement as Must / Should / Could / Won't (MoSCoW)" },
    { heading: "Open Questions", description: "unresolved clarifications for the requester" },
  ],
  architect: [
    { heading: "Technical Decisions", description: "for each key decision record Decision, Options Considered, Choice, Rationale, and Trade-offs" },
    { heading: "Interface Contracts", description: "for each interface give the signature, request/response schema, error contract, and data model" },
    { heading: "Data Flow and Deployment", description: "data flow, deployment expectations, and rollback strategy" },
    { heading: "Architecture Review Checklist", description: "how the design traces back to the approved requirements" },
  ],
  implementer: [
    { heading: "Implementation Summary", description: "the smallest change that satisfies the approved architecture" },
    { heading: "Standards Compliance", description: "follow discovered standards and lint/format rules; run available lint/format/typecheck and report results" },
    { heading: "Changed Files", description: "every file you created or modified" },
    { heading: "Tests Added or Updated", description: "tests covering success, edge, and failure paths" },
  ],
  tester: [
    { heading: "Test Cases", description: "enumerate cases as a table with ID, Scenario, Type (happy/edge/failure/regression), and Expected result" },
    { heading: "Coverage", description: "run the coverage command and report the coverage summary plus any gaps" },
    { heading: "Verification Evidence", description: "exact commands, exit codes, and key output" },
    { heading: "Known Risks", description: "residual risks and follow-ups" },
  ],
};

export interface DevCrewConfig {
  version: 1;
  defaultBackend: "host-preferred" | BackendName;
  executionMode: ExecutionMode;
  verifyCommands: string[];
  lintCommands: string[];
  coverageCommands: string[];
  workflow: {
    gates: GateName[];
    artifactDirectory: string;
  };
}

export interface StandardsDiscovery {
  sources: string[];
  combined: string;
}

export interface RoleResult {
  role: "conductor" | "pm" | "architect" | "implementer" | "tester";
  backend: BackendName;
  summary: string;
  markdown: string;
  usedFallback: boolean;
  questions?: string[];
}

export interface WorkflowFeedback {
  gate: GateName;
  message: string;
  createdAt: string;
}

export interface WorkflowApproval {
  gate: GateName;
  note?: string;
  createdAt: string;
}

export interface WorkflowAnswer {
  answer: string;
  createdAt: string;
}

export interface VerificationWaiver {
  reason: string;
  createdAt: string;
}

// Reused for both verification and lint results — the command shape is identical.
export interface VerificationResult {
  command: string;
  exitCode: number;
  output: string;
  startedAt: string;
  completedAt: string;
}

export interface ExecutionWorkspace {
  path: string;
  baseCommit: string;
}

export interface ExecutionInstruction {
  phase: "execution" | "testing";
  workspacePath: string;
  instructions: string;
  createdAt: string;
}

export interface RunState {
  version: 1;
  runId: string;
  cwd: string;
  host: Host;
  mode: WorkflowMode;
  executionMode: ExecutionMode;
  executionPolicy: ExecutionPolicy;
  executionWorkspace?: ExecutionWorkspace;
  executionInstruction?: ExecutionInstruction;
  backend: BackendName;
  request: string;
  phase: Phase;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  gates: Record<GateName, GateStatus>;
  artifacts: Partial<Record<ArtifactName, string>>;
  roles: RoleResult[];
  pendingQuestions: string[];
  answers: WorkflowAnswer[];
  approvals: WorkflowApproval[];
  feedback: WorkflowFeedback[];
  standards: StandardsDiscovery;
  changedFiles: string[];
  implementationDiff: string;
  verification: VerificationResult[];
  verificationStatus: VerificationStatus;
  verificationWaiver?: VerificationWaiver;
  // VerificationResult is reused for lint output — same shape, different semantics.
  lintResults: VerificationResult[];
}

export interface StartWorkflowInput {
  cwd: string;
  host: Host;
  mode: WorkflowMode;
  request: string;
  backend?: BackendName;
  executionMode?: ExecutionMode;
  executionPolicy?: ExecutionPolicy;
}

export interface RunRef {
  cwd: string;
  runId: string;
}

export interface ApproveWorkflowInput extends RunRef {
  gate: GateName;
  note?: string;
}

export interface RejectWorkflowInput extends RunRef {
  gate: GateName;
  feedback: string;
}

export interface AnswerWorkflowInput extends RunRef {
  answer: string;
}

export interface WaiveVerificationInput extends RunRef {
  reason: string;
}

export interface CompleteExecutionInput extends RunRef {
  summary: string;
  verification?: VerificationResult[];
}

export interface ArtifactRef extends RunRef {
  name: ArtifactName;
}

export interface ArtifactReadResult {
  name: ArtifactName;
  path: string;
  content: string;
  summary: string;
}
