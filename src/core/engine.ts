import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { ensureVisitDirectories, readNodeResult, visitPaths } from "./artifact-store.js";
import { canonicalJson, isJsonValue, sha256Text } from "./json.js";
import { evaluateExpression } from "./expression.js";
import { appendRunEvent, createRun, getRunPaths, readRun, updateRun } from "./state-store.js";
import { loadWorkflow, resolveGraphSkillPins, type WorkflowRoots } from "./workflow-loader.js";
import type {
  CurrentVisit,
  GraphEvent,
  JsonObject,
  NodeResult,
  ResolvedSkillPin,
  RunSummary,
  SkillGraph,
  SkillGraphEdge,
  SkillGraphNode,
  StageContext,
  WorkflowManifest,
  WorkflowRunState,
} from "./types.js";
import { SkillGraphError } from "./types.js";

function now(): string { return new Date().toISOString(); }

function assertRequiredInputs(graph: SkillGraph, input: JsonObject): void {
  const missing = graph.requiredInputs.filter((name) => !Object.hasOwn(input, name));
  if (missing.length > 0) {
    throw new SkillGraphError(
      "invalid_input",
      `Workflow ${graph.id} requires input: ${missing.join(", ")}`,
      { workflow_id: graph.id, missing_inputs: missing },
    );
  }
}

function resultJson(result: NodeResult): JsonObject {
  return {
    schema_version: 1,
    node_id: result.nodeId,
    visit_id: result.visitId,
    status: result.status,
    summary: result.summary,
    artifacts: result.artifacts.map((artifact) => ({ name: artifact.name, path: artifact.path, ...(artifact.schema ? { schema: artifact.schema } : {}) })),
    issues: result.issues.map((issue) => ({ message: issue.message, ...(issue.code ? { code: issue.code } : {}), ...(issue.severity ? { severity: issue.severity } : {}) })),
    ...(result.decision ? { decision: result.decision } : {}),
    ...(result.metrics ? { metrics: result.metrics } : {}),
    ...(result.evidence ? { evidence: result.evidence } : {}),
    ...(result.next ? { next: result.next } : {}),
  };
}

function graphNode(graph: SkillGraph, nodeId: string): SkillGraphNode {
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node) throw new SkillGraphError("invalid_graph", `Node ${nodeId} does not exist`);
  return node;
}

function graphEdges(graph: SkillGraph, nodeId: string): SkillGraphEdge[] {
  return graph.edges.filter((edge) => edge.from === nodeId);
}

function templateReference(value: string, state: WorkflowRunState, bindings: Record<string, JsonValueLike>): JsonValueLike {
  const exact = value.match(/^\{\{(input|artifact|result):([^:}]+)(?::([^}]+))?\}\}$/);
  if (exact) return lookupReference(exact[1], exact[2], exact[3], state, bindings);
  return value.replace(/\{\{(input|artifact|result):([^:}]+)(?::([^}]+))?\}\}/g, (_match, type: string, first: string, field?: string) => String(lookupReference(type, first, field, state, bindings) ?? ""));
}

type JsonValueLike = string | number | boolean | null | JsonObject | JsonValueLike[] | undefined;

function lookupReference(type: string, first: string, field: string | undefined, state: WorkflowRunState, bindings: Record<string, JsonValueLike>): JsonValueLike {
  if (type === "input") return Object.hasOwn(bindings, first) ? bindings[first] : state.input[first];
  if (type === "artifact") {
    const artifact = state.artifacts[`${first}:${field ?? ""}`];
    if (!artifact) throw new SkillGraphError("invalid_route", `Artifact ${first}:${field ?? ""} is not available`);
    return join(getRunPaths(state.cwd, state.runId).root, "stages", artifact.nodeId, "visits", artifact.visitId, artifact.relativePath);
  }
  const result = state.results[first];
  if (!result) throw new SkillGraphError("invalid_route", `Result ${first} is not available`);
  if (!field) return result;
  let value: unknown = result;
  for (const part of field.split(".")) value = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[part] : undefined;
  return value as JsonValueLike;
}

function resolveNodeInputs(node: SkillGraphNode, state: WorkflowRunState, bindings: Record<string, JsonValueLike> = {}): JsonObject {
  const result: JsonObject = {};
  for (const [name, value] of Object.entries(node.inputs ?? {})) {
    const resolved = templateReference(value, state, bindings);
    if (!isJsonValue(resolved)) throw new SkillGraphError("invalid_route", `Input ${name} is not JSON serializable`);
    result[name] = resolved;
  }
  for (const [name, value] of Object.entries(bindings)) {
    if (!isJsonValue(value)) throw new SkillGraphError("invalid_route", `Binding ${name} is not JSON serializable`);
    result[name] = value;
  }
  return result;
}

function newVisitId(): string { return `v-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`; }
function newRunId(): string { return `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`; }

function activateNode(graph: SkillGraph, state: WorkflowRunState, nodeId: string, bindings: Record<string, JsonValueLike> = {}, loopId?: string): CurrentVisit {
  const node = graphNode(graph, nodeId);
  if (Date.now() - Date.parse(state.startedAt) > graph.budgets.maxDurationMs) throw new SkillGraphError("budget_exceeded", "Workflow exceeded its time budget");
  const visits = (state.nodeVisits[nodeId] ?? 0) + 1;
  const maxVisits = node.maxVisits ?? graph.budgets.maxVisits;
  if (visits > maxVisits || Object.values(state.nodeVisits).reduce((sum, value) => sum + value, 0) >= graph.budgets.maxVisits) throw new SkillGraphError("budget_exceeded", `Node ${nodeId} exceeded its visit budget`);
  if (state.agentTurns >= graph.budgets.maxAgentTurns) throw new SkillGraphError("budget_exceeded", "Workflow exceeded its Agent turn budget");
  const input = resolveNodeInputs(node, state, bindings);
  const inputFingerprint = sha256Text(canonicalJson({ nodeId, input }));
  if (loopId) {
    const frame = state.loopFrames[loopId];
    if (frame?.lastInputFingerprint === inputFingerprint) throw new SkillGraphError("input_repeat", `Loop ${loopId} repeated the same input`);
    if (frame) frame.lastInputFingerprint = inputFingerprint;
  }
  state.nodeVisits[nodeId] = visits;
  state.agentTurns += 1;
  return { nodeId, visitId: newVisitId(), status: "awaiting_agent", inputFingerprint, attempt: visits, activatedAt: now(), input };
}

function selectEdge(graph: SkillGraph, nodeId: string, result: NodeResult): SkillGraphEdge | undefined {
  const edges = graphEdges(graph, nodeId);
  if (edges.length === 0) return undefined;
  const value = resultJson(result);
  if (result.next?.requested) {
    const requested = edges.find((edge) => edge.id === result.next?.requested);
    if (!requested) throw new SkillGraphError("invalid_route", `Requested edge ${result.next.requested} is not declared by ${nodeId}`);
    if (!evaluateExpression(requested.when, { result: value })) throw new SkillGraphError("invalid_route", `Requested edge ${requested.id} does not match its condition`);
    return requested;
  }
  const matches = edges.filter((edge) => evaluateExpression(edge.when, { result: value })).sort((a, b) => b.priority - a.priority);
  if (matches.length === 0) throw new SkillGraphError("no_route", `No declared edge matches node ${nodeId}`);
  if (matches.length > 1 && matches[0].priority === matches[1].priority) throw new SkillGraphError("ambiguous_route", `Multiple edges match node ${nodeId} at priority ${matches[0].priority}`);
  return matches[0];
}

function skillForNode(manifest: WorkflowManifest, node: SkillGraphNode): ResolvedSkillPin {
  const skill = manifest.skills.find((item) => item.id === node.skill);
  if (!skill) throw new SkillGraphError("missing_skill", `Skill ${node.skill} is not pinned in the run manifest`);
  return skill;
}

function makeEvent(runId: string, type: string, data?: JsonObject, current?: CurrentVisit): GraphEvent {
  return { type, at: now(), runId, ...(current ? { nodeId: current.nodeId, visitId: current.visitId } : {}), ...(data ? { data } : {}) };
}

export interface SkillGraphEngineOptions {
  cwd: string;
  sessionId: string;
  roots?: WorkflowRoots;
}

export class SkillGraphEngine {
  readonly cwd: string;
  readonly sessionId: string;
  readonly roots?: WorkflowRoots;

  constructor(options: SkillGraphEngineOptions) {
    this.cwd = resolve(options.cwd);
    this.sessionId = options.sessionId;
    this.roots = options.roots;
  }

  private async graphForRun(state: WorkflowRunState): Promise<{ graph: SkillGraph; manifest: WorkflowManifest }> {
    const run = await readRun(this.cwd, state.runId);
    if (run.state.sessionId !== this.sessionId) throw new SkillGraphError("stale_stage", "This workflow run belongs to another session");
    const graph = await loadWorkflow({ cwd: this.cwd, workflowId: run.state.workflowId, roots: this.roots });
    if (graph.graphHash !== run.state.graphHash) throw new SkillGraphError("invalid_graph", "Workflow definition changed since this run started");
    const currentPins = resolveGraphSkillPins(graph, this.cwd, this.roots);
    for (const pinned of run.manifest.skills) {
      const current = currentPins.find((item) => item.id === pinned.id);
      if (!current || current.sha256 !== pinned.sha256) throw new SkillGraphError("skill_changed", `Skill ${pinned.id} changed since this run started`);
    }
    return { graph, manifest: run.manifest };
  }

  async execute(workflowId: string, input: JsonObject = {}): Promise<StageContext> {
    const graph = await loadWorkflow({ cwd: this.cwd, workflowId, roots: this.roots });
    if (graph.mode !== "agent") throw new SkillGraphError("invalid_graph", "CLI workflows cannot be started by an Agent session");
    assertRequiredInputs(graph, input);
    const pins = resolveGraphSkillPins(graph, this.cwd, this.roots);
    const runId = newRunId();
    const createdAt = now();
    const manifest: WorkflowManifest = { schemaVersion: 1, runId, sessionId: this.sessionId, cwd: this.cwd, workflowId: graph.id, workflowVersion: graph.version, graphHash: graph.graphHash, skills: pins, createdAt };
    const state: WorkflowRunState = { schemaVersion: 1, runId, sessionId: this.sessionId, cwd: this.cwd, workflowId: graph.id, workflowVersion: graph.version, graphHash: graph.graphHash, status: "active", input, completedNodes: [], nodeVisits: {}, loopFrames: {}, artifacts: {}, results: {}, agentTurns: 0, startedAt: createdAt, updatedAt: createdAt };
    state.current = activateNode(graph, state, graph.entry);
    await createRun(manifest, state);
    await appendRunEvent(this.cwd, runId, makeEvent(runId, "run_created", { workflow_id: graph.id, graph_hash: graph.graphHash }));
    await appendRunEvent(this.cwd, runId, makeEvent(runId, "node_activated", undefined, state.current));
    return this.contextFrom(graph, manifest, state);
  }

  async stageContext(runId: string): Promise<StageContext> {
    const run = await readRun(this.cwd, runId);
    const { graph, manifest } = await this.graphForRun(run.state);
    if (!run.state.current) throw new SkillGraphError("run_not_found", "Workflow run has no current node");
    if (run.state.status !== "active" && run.state.status !== "paused") throw new SkillGraphError("stale_stage", `Workflow run is ${run.state.status}`);
    if (Date.now() - Date.parse(run.state.startedAt) > graph.budgets.maxDurationMs) {
      await this.fail(runId, "budget_exceeded", "Workflow exceeded its time budget");
      throw new SkillGraphError("budget_exceeded", "Workflow exceeded its time budget");
    }
    ensureVisitDirectories(this.cwd, runId, run.state.current.nodeId, run.state.current.visitId);
    return this.contextFrom(graph, manifest, run.state);
  }

  private contextFrom(graph: SkillGraph, manifest: WorkflowManifest, state: WorkflowRunState): StageContext {
    if (!state.current) throw new SkillGraphError("run_not_found", "Workflow run has no current node");
    const node = graphNode(graph, state.current.nodeId);
    const paths = visitPaths(this.cwd, state.runId, node.id, state.current.visitId);
    ensureVisitDirectories(this.cwd, state.runId, node.id, state.current.visitId);
    return { runId: state.runId, workflowId: state.workflowId, nodeId: node.id, visitId: state.current.visitId, attempt: state.current.attempt, task: node.task, skill: skillForNode(manifest, node), inputs: state.current.input, requiredOutputs: node.outputs, resultPath: paths.result, outputDirectory: paths.outputs, allowedEdges: graphEdges(graph, node.id).map((edge) => ({ id: edge.id, to: edge.to, ...(edge.when ? { when: edge.when } : {}), priority: edge.priority })) };
  }

  async submit(runId: string, nodeId: string, visitId: string, resultPath?: string): Promise<{ status: string; result?: NodeResult; next?: StageContext; error?: { code: string; message: string } }> {
    const run = await readRun(this.cwd, runId);
    const { graph, manifest } = await this.graphForRun(run.state);
    if (run.state.status !== "active" || !run.state.current || run.state.current.nodeId !== nodeId || run.state.current.visitId !== visitId) throw new SkillGraphError("stale_stage", "The submitted stage is no longer current");
    if (Date.now() - Date.parse(run.state.startedAt) > graph.budgets.maxDurationMs) {
      await this.fail(runId, "budget_exceeded", "Workflow exceeded its time budget");
      throw new SkillGraphError("budget_exceeded", "Workflow exceeded its time budget");
    }
    const node = graphNode(graph, nodeId);
    let checked: ReturnType<typeof readNodeResult>;
    try {
      checked = readNodeResult(this.cwd, runId, node, visitId, graph, resultPath);
    } catch (error) {
      await this.fail(runId, error instanceof SkillGraphError ? error.code : "invalid_result", error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (checked.result.status !== "success") {
      const code = checked.result.status === "needs_input" ? "needs_input" : checked.result.status === "blocked" ? "blocked" : "failed";
      await updateRun(this.cwd, runId, ({ state }) => ({ state: { ...state, status: checked.result.status === "failed" ? "failed" : "blocked", updatedAt: now(), current: state.current ? { ...state.current, status: checked.result.status } : undefined, results: { ...state.results, [nodeId]: resultJson(checked.result) }, lastError: { code, message: checked.result.summary } }, result: undefined }));
      await appendRunEvent(this.cwd, runId, makeEvent(runId, "node_submitted", { status: checked.result.status }, run.state.current));
      return { status: checked.result.status, result: checked.result };
    }
    try {
      const next = await updateRun(this.cwd, runId, ({ state }) => {
        const artifacts = { ...state.artifacts };
        for (const artifact of checked.records) artifacts[`${nodeId}:${artifact.name}`] = artifact;
        const nextState: WorkflowRunState = { ...state, updatedAt: now(), completedNodes: [...new Set([...state.completedNodes, nodeId])], artifacts, results: { ...state.results, [nodeId]: resultJson(checked.result) }, current: state.current ? { ...state.current, status: "success" } : undefined };
        const edge = selectEdge(graph, nodeId, checked.result);
        if (!edge) {
          nextState.status = "completed";
          nextState.current = undefined;
          return { state: nextState, result: undefined as StageContext | undefined };
        }
        if (edge.loop) {
          const existing = nextState.loopFrames[edge.loop.id];
          const frame = existing ?? { id: edge.loop.id, iterations: 0, maxIterations: edge.loop.maxIterations };
          frame.iterations += 1;
          if (frame.iterations > frame.maxIterations) throw new SkillGraphError("loop_limit", `Loop ${edge.loop.id} exceeded ${edge.loop.maxIterations} iterations`);
          nextState.loopFrames = { ...nextState.loopFrames, [edge.loop.id]: frame };
        }
        const bindings: Record<string, JsonValueLike> = {};
        for (const [key, reference] of Object.entries(edge.bind ?? {})) bindings[key] = templateReference(reference, nextState, {});
        nextState.current = activateNode(graph, nextState, edge.to, bindings, edge.loop?.id);
        return { state: nextState, result: this.contextFrom(graph, manifest, nextState) };
      });
      await appendRunEvent(this.cwd, runId, makeEvent(runId, "node_submitted", { status: "success" }, run.state.current));
      if (!next) await appendRunEvent(this.cwd, runId, makeEvent(runId, "run_completed", { workflow_id: graph.id }));
      else await appendRunEvent(this.cwd, runId, makeEvent(runId, "node_activated", undefined, (await readRun(this.cwd, runId)).state.current));
      return { status: next ? "success" : "completed", result: checked.result, ...(next ? { next } : {}) };
    } catch (error) {
      await this.fail(runId, error instanceof SkillGraphError ? error.code : "invalid_route", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async resume(runId: string): Promise<StageContext> {
    const run = await readRun(this.cwd, runId);
    const { graph, manifest } = await this.graphForRun(run.state);
    if (run.state.status === "active") throw new SkillGraphError("run_busy", "Workflow run is already active; do not resume it concurrently");
    if (run.state.status === "completed") throw new SkillGraphError("stale_stage", "Completed workflow runs cannot be resumed");
    if (run.state.status === "budget_exceeded") throw new SkillGraphError("budget_exceeded", "Workflow runs that exceeded a budget cannot be resumed");
    if (!run.state.current) throw new SkillGraphError("run_not_found", "Workflow run has no current node");
    const context = await updateRun(this.cwd, runId, ({ state }) => {
      const current = state.current!;
      if (state.status === "paused" && current.status === "awaiting_agent") return { state: { ...state, status: "active", updatedAt: now() }, result: undefined };
      const next = activateNode(graph, state, current.nodeId, current.input);
      return { state: { ...state, status: "active", updatedAt: now(), current: next, lastError: undefined }, result: this.contextFrom(graph, manifest, { ...state, current: next }) };
    });
    await appendRunEvent(this.cwd, runId, makeEvent(runId, "run_resumed"));
    return context ?? this.stageContext(runId);
  }

  async pause(runId: string, reason = "agent stopped"): Promise<void> {
    const run = await readRun(this.cwd, runId);
    if (run.state.status !== "active") return;
    await updateRun(this.cwd, runId, ({ state }) => ({ state: { ...state, status: "paused", updatedAt: now(), lastError: { code: "paused", message: reason } }, result: undefined }));
    await appendRunEvent(this.cwd, runId, makeEvent(runId, "run_paused", { reason }));
  }

  async summary(runId: string): Promise<RunSummary> {
    const { state } = await readRun(this.cwd, runId);
    return { runId: state.runId, workflowId: state.workflowId, workflowVersion: state.workflowVersion, status: state.status, ...(state.current ? { currentNodeId: state.current.nodeId, currentVisitId: state.current.visitId } : {}), updatedAt: state.updatedAt, ...(state.lastError ? { lastError: state.lastError } : {}) };
  }

  private async fail(runId: string, code: string, error: string): Promise<void> {
    await updateRun(this.cwd, runId, ({ state }) => ({ state: { ...state, status: code === "budget_exceeded" || code === "loop_limit" ? "budget_exceeded" : "blocked", updatedAt: now(), lastError: { code, message: error }, current: state.current ? { ...state.current, status: "blocked" } : undefined }, result: undefined }));
    await appendRunEvent(this.cwd, runId, makeEvent(runId, "validation_failed", { code, message: error }));
  }
}
