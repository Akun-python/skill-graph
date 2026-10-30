export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type WorkflowMode = "agent" | "cli";
export type RunStatus = "active" | "paused" | "completed" | "blocked" | "failed" | "budget_exceeded";
export type NodeStatus = "pending" | "awaiting_agent" | "submitting" | "success" | "blocked" | "needs_input" | "failed";
export type NodeResultStatus = "success" | "blocked" | "needs_input" | "failed";

export interface SkillContract {
  id: string;
  version: number;
  /** Optional project-relative path to a local SKILL.md. */
  path?: string;
  consumes?: string[];
  produces?: string[];
}

export interface SkillGraphEdge {
  id: string;
  from: string;
  to: string;
  when?: string;
  priority: number;
  bind?: Record<string, string>;
  loop?: {
    id: string;
    maxIterations: number;
  };
}

export interface SkillGraphOutput {
  name: string;
  schema?: string;
  required: boolean;
}

export interface SkillGraphNode {
  id: string;
  type: "agent";
  skill: string;
  task: string;
  inputs?: Record<string, string>;
  outputs: SkillGraphOutput[];
  resultSchema?: string;
  terminal?: boolean;
  maxVisits?: number;
}

export interface SkillGraphBudget {
  maxVisits: number;
  maxAgentTurns: number;
  maxDurationMs: number;
}

export interface SkillGraph {
  schemaVersion: 1;
  id: string;
  version: number;
  mode: WorkflowMode;
  requiredInputs: string[];
  entry: string;
  nodes: SkillGraphNode[];
  edges: SkillGraphEdge[];
  budgets: SkillGraphBudget;
  sourcePath: string;
  sourceScope: "project" | "user" | "builtin";
  graphHash: string;
  skillContracts: SkillContract[];
}

export interface ResolvedSkillPin {
  id: string;
  version: number;
  filePath: string;
  baseDir: string;
  sha256: string;
}

export interface WorkflowManifest {
  schemaVersion: 1;
  runId: string;
  sessionId: string;
  cwd: string;
  workflowId: string;
  workflowVersion: number;
  graphHash: string;
  skills: ResolvedSkillPin[];
  createdAt: string;
}

export interface ArtifactRecord {
  name: string;
  relativePath: string;
  schema?: string;
  sha256: string;
  bytes: number;
  nodeId: string;
  visitId: string;
  promoted: boolean;
  verifiedAt: string;
}

export interface LoopFrame {
  id: string;
  iterations: number;
  maxIterations: number;
  lastInputFingerprint?: string;
  stopReason?: string;
}

export interface CurrentVisit {
  nodeId: string;
  visitId: string;
  status: NodeStatus;
  inputFingerprint: string;
  attempt: number;
  activatedAt: string;
  input: JsonObject;
}

export interface WorkflowRunState {
  schemaVersion: 1;
  runId: string;
  sessionId: string;
  cwd: string;
  workflowId: string;
  workflowVersion: number;
  graphHash: string;
  status: RunStatus;
  input: JsonObject;
  current?: CurrentVisit;
  completedNodes: string[];
  nodeVisits: Record<string, number>;
  loopFrames: Record<string, LoopFrame>;
  artifacts: Record<string, ArtifactRecord>;
  results: Record<string, JsonObject>;
  agentTurns: number;
  startedAt: string;
  updatedAt: string;
  lastError?: { code: string; message: string };
}

export interface NodeArtifactInput {
  name: string;
  path: string;
  schema?: string;
}

export interface NodeResult {
  schemaVersion: 1;
  nodeId: string;
  visitId: string;
  status: NodeResultStatus;
  decision?: string;
  summary: string;
  metrics?: JsonObject;
  evidence?: Array<{ artifact: string; claim: string }>;
  artifacts: NodeArtifactInput[];
  issues: Array<{ code?: string; message: string; severity?: "info" | "warning" | "error" }>;
  next?: { requested?: string };
}

export interface StageContext {
  runId: string;
  workflowId: string;
  nodeId: string;
  visitId: string;
  attempt: number;
  task: string;
  skill: ResolvedSkillPin;
  inputs: JsonObject;
  requiredOutputs: SkillGraphOutput[];
  resultPath: string;
  outputDirectory: string;
  allowedEdges: Array<{ id: string; to: string; when?: string; priority: number }>;
}

export interface GraphEvent {
  type: string;
  at: string;
  runId: string;
  nodeId?: string;
  visitId?: string;
  data?: JsonObject;
}

export type GraphErrorCode =
  | "invalid_graph"
  | "invalid_input"
  | "workflow_not_found"
  | "project_untrusted"
  | "missing_skill"
  | "skill_changed"
  | "run_not_found"
  | "run_busy"
  | "stale_stage"
  | "invalid_result"
  | "invalid_artifact"
  | "invalid_route"
  | "no_route"
  | "ambiguous_route"
  | "loop_limit"
  | "input_repeat"
  | "budget_exceeded"
  | "storage_error";

export class SkillGraphError extends Error {
  readonly code: GraphErrorCode;
  readonly details?: JsonObject;

  constructor(code: GraphErrorCode, message: string, details?: JsonObject) {
    super(message);
    this.name = "SkillGraphError";
    this.code = code;
    this.details = details;
  }
}

export interface WorkflowSummary {
  id: string;
  version: number;
  mode: WorkflowMode;
  sourceScope: SkillGraph["sourceScope"];
  sourcePath: string;
  graphHash?: string;
  requiredInputs?: string[];
  diagnostic?: string;
}

export interface RunSummary {
  runId: string;
  workflowId: string;
  workflowVersion: number;
  status: RunStatus;
  currentNodeId?: string;
  currentVisitId?: string;
  updatedAt: string;
  lastError?: WorkflowRunState["lastError"];
}
