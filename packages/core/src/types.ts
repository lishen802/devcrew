export const WORKFLOW_MODES = ["feature", "greenfield"] as const;
export const HOSTS = ["codex", "claude"] as const;
export const BACKENDS = ["codex", "claude", "local"] as const;
export const PHASES = [
  "requirements",
  "architecture",
  "implementation",
  "testing",
  "acceptance",
  "complete",
] as const;
export const GATES = ["requirements", "architecture", "implementation", "testing"] as const;
export const ARTIFACTS = [
  "requirements",
  "architecture",
  "implementation-plan",
  "test-report",
  "acceptance",
] as const;

export type WorkflowMode = (typeof WORKFLOW_MODES)[number];
export type Host = (typeof HOSTS)[number];
export type BackendName = (typeof BACKENDS)[number];
export type Phase = (typeof PHASES)[number];
export type GateName = (typeof GATES)[number];
export type ArtifactName = (typeof ARTIFACTS)[number];
export type GateStatus = "not_started" | "pending" | "approved" | "rejected";
export type RunStatus = "ready" | "awaiting_input" | "awaiting_approval" | "complete";

export interface DevCrewConfig {
  version: 1;
  defaultBackend: "host-preferred" | BackendName;
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

export interface RunState {
  version: 1;
  runId: string;
  cwd: string;
  host: Host;
  mode: WorkflowMode;
  backend: BackendName;
  request: string;
  phase: Phase;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  gates: Record<GateName, GateStatus>;
  artifacts: Partial<Record<ArtifactName, string>>;
  roles: RoleResult[];
  answers: WorkflowAnswer[];
  approvals: WorkflowApproval[];
  feedback: WorkflowFeedback[];
  standards: StandardsDiscovery;
}

export interface StartWorkflowInput {
  cwd: string;
  host: Host;
  mode: WorkflowMode;
  request: string;
  backend?: BackendName;
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

export interface ArtifactRef extends RunRef {
  name: ArtifactName;
}

export interface ArtifactReadResult {
  name: ArtifactName;
  path: string;
  content: string;
  summary: string;
}
