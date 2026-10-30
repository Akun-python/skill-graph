import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { JSON_SCHEMA, load } from "js-yaml";
import { canonicalJson, isRecord, sha256Text } from "./json.js";
import type {
  SkillContract,
  SkillGraph,
  SkillGraphBudget,
  SkillGraphEdge,
  SkillGraphNode,
  SkillGraphOutput,
  WorkflowMode,
  WorkflowSummary,
  ResolvedSkillPin,
} from "./types.js";
import { SkillGraphError } from "./types.js";

const MAX_WORKFLOW_BYTES = 1024 * 1024;
const MAX_SKILLS_BYTES = 1024 * 1024;
const MAX_NODES = 100;
const MAX_EDGES = 300;
const MAX_STRING = 16_384;
const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface RawWorkflowDocument extends Record<string, unknown> {
  schema_version?: unknown;
  schemaVersion?: unknown;
  id?: unknown;
  name?: unknown;
  version?: unknown;
  mode?: unknown;
  execution?: unknown;
  required_inputs?: unknown;
  requiredInputs?: unknown;
  entry?: unknown;
  nodes?: unknown;
  stages?: unknown;
  edges?: unknown;
  budgets?: unknown;
}

interface LoadWorkflowOptions {
  cwd: string;
  workflowId: string;
  roots?: WorkflowRoots;
}

export interface WorkflowRoots {
  projectRoots?: string[];
  userRoots?: string[];
}

interface WorkflowSource {
  path: string;
  scope: SkillGraph["sourceScope"];
  root: string;
}

const DEFAULT_PROJECT_ROOT_NAMES = [".skill-workflows", ".skill-graph"];

function defaultRoots(cwd: string): Required<WorkflowRoots> {
  const configured = process.env.SKILL_GRAPH_HOME?.trim();
  const userRoots = [
    configured,
    join(homedir(), ".skill-graph"),
    join(homedir(), ".pi", "agent", "skill-workflows"),
  ].filter((value): value is string => Boolean(value));
  return {
    projectRoots: DEFAULT_PROJECT_ROOT_NAMES.map((name) => join(cwd, name)),
    userRoots: [...new Set(userRoots.map((value) => resolve(value)))],
  };
}

function normaliseRoots(cwd: string, roots?: WorkflowRoots): Required<WorkflowRoots> {
  const defaults = defaultRoots(cwd);
  return {
    projectRoots: [...new Set((roots?.projectRoots ?? defaults.projectRoots).map((value) => resolve(value)))],
    userRoots: [...new Set((roots?.userRoots ?? defaults.userRoots).map((value) => resolve(value)))],
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertString(value: unknown, name: string, max = MAX_STRING): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new SkillGraphError("invalid_graph", `${name} must be a non-empty string`);
  return value;
}

function assertId(value: unknown, name: string): string {
  const id = assertString(value, name, 128);
  if (!WORKFLOW_ID.test(id)) throw new SkillGraphError("invalid_graph", `${name} contains invalid characters`);
  return id;
}

function assertPositiveInteger(value: unknown, name: string, max: number): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) throw new SkillGraphError("invalid_graph", `${name} must be an integer between 1 and ${max}`);
  return value as number;
}

function parseYaml(text: string, path: string): unknown {
  try {
    return load(text, { schema: JSON_SCHEMA, json: false });
  } catch (error) {
    throw new SkillGraphError("invalid_graph", `${path} is not valid YAML: ${message(error)}`);
  }
}

function readYaml(path: string, maxBytes: number): unknown {
  let text: string | undefined;
  try {
    const stats = statSync(path);
    if (stats.isFile() && stats.size <= maxBytes) text = readFileSync(path, "utf8");
  } catch { /* handled as a missing workflow below */ }
  if (text === undefined) throw new SkillGraphError("workflow_not_found", `Workflow file not found: ${basename(path)}`);
  return parseYaml(text, path);
}

function findSource(cwd: string, workflowId: string, roots: Required<WorkflowRoots>): WorkflowSource | undefined {
  for (const [scope, candidates] of [["project", roots.projectRoots], ["user", roots.userRoots]] as const) {
    for (const root of candidates) {
    for (const extension of [".yaml", ".yml"]) {
      const path = join(root, "workflows", `${workflowId}${extension}`);
      if (existsSync(path)) return { path, scope, root };
    }
    }
  }
  return undefined;
}

function listSources(cwd: string, roots: Required<WorkflowRoots>): WorkflowSummary[] {
  const summaries: WorkflowSummary[] = [];
  const seen = new Set<string>();
  for (const [scope, candidates] of [["project", roots.projectRoots], ["user", roots.userRoots]] as const) {
    for (const root of candidates) {
    const directory = join(root, "workflows");
    if (!existsSync(directory)) continue;
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch (error) {
      summaries.push({ id: "unknown", version: 0, mode: "agent", sourceScope: scope, sourcePath: directory, diagnostic: message(error) });
      continue;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
      const id = entry.replace(/\.ya?ml$/i, "");
      if (!WORKFLOW_ID.test(id) || seen.has(id)) continue;
      seen.add(id);
      const path = join(directory, entry);
      try {
        const graph = parseWorkflowDocument(readYaml(path, MAX_WORKFLOW_BYTES), path, scope);
        summaries.push({ id: graph.id, version: graph.version, mode: graph.mode, sourceScope: scope, sourcePath: path, graphHash: graph.graphHash, requiredInputs: graph.requiredInputs });
      } catch (error) {
        summaries.push({ id, version: 0, mode: "agent", sourceScope: scope, sourcePath: path, diagnostic: message(error) });
      }
    }
    }
  }
  return summaries;
}

function parseContracts(source: WorkflowSource): SkillContract[] {
  const path = join(source.root, "graph", "skills.yaml");
  if (!existsSync(path)) return [];
  const raw = readYaml(path, MAX_SKILLS_BYTES);
  if (!isRecord(raw) || !Array.isArray(raw.skills)) throw new SkillGraphError("invalid_graph", `${path} must contain skills[]`);
  if (raw.skills.length > MAX_NODES) throw new SkillGraphError("invalid_graph", `${path} cannot declare more than ${MAX_NODES} skills`);
  const contracts: SkillContract[] = [];
  for (const [index, item] of raw.skills.entries()) {
    if (!isRecord(item)) throw new SkillGraphError("invalid_graph", `${path} skills[${index}] must be an object`);
    const id = assertId(item.id, `skills[${index}].id`);
    const version = assertPositiveInteger(item.version, `skills[${index}].version`, 1_000_000);
    const skillPath = item.path === undefined ? undefined : assertString(item.path, `skills[${index}].path`, 2048);
    if (skillPath !== undefined) {
      const normalized = skillPath.replace(/\\/g, "/");
      if (isAbsolute(skillPath) || /[\0:]/.test(skillPath) || normalized.split("/").some((part) => part === ".." || part === "" || part === ".")) {
        throw new SkillGraphError("invalid_graph", `skills[${index}].path must be a project-relative path without traversal`);
      }
    }
    const list = (value: unknown, name: string): string[] | undefined => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length > 256)) throw new SkillGraphError("invalid_graph", `${name} must be a list of strings`);
      return [...new Set(value as string[])];
    };
    const consumes = list(item.consumes, `skills[${index}].consumes`);
    const produces = list(item.produces, `skills[${index}].produces`);
    contracts.push({ id, version, ...(skillPath === undefined ? {} : { path: skillPath }), ...(consumes ? { consumes } : {}), ...(produces ? { produces } : {}) });
  }
  if (new Set(contracts.map((item) => item.id)).size !== contracts.length) throw new SkillGraphError("invalid_graph", "skills.yaml contains duplicate skill ids");
  return contracts;
}

function parseOutputs(value: unknown, nodeName: string): SkillGraphOutput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new SkillGraphError("invalid_graph", `${nodeName}.outputs must be a list`);
  const outputs = value.map((entry, index) => {
    if (typeof entry === "string") return { name: assertId(entry, `${nodeName}.outputs[${index}]`), required: true };
    if (!isRecord(entry)) throw new SkillGraphError("invalid_graph", `${nodeName}.outputs[${index}] must be a string or object`);
    const output = { name: assertId(entry.name, `${nodeName}.outputs[${index}].name`), required: entry.required === undefined ? true : entry.required === true, ...(entry.schema === undefined ? {} : { schema: assertString(entry.schema, `${nodeName}.outputs[${index}].schema`, 256) }) };
    return output;
  });
  if (new Set(outputs.map((item) => item.name)).size !== outputs.length) throw new SkillGraphError("invalid_graph", `${nodeName}.outputs contains duplicate names`);
  return outputs;
}

function parseInputs(value: unknown, nodeName: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new SkillGraphError("invalid_graph", `${nodeName}.inputs must be an object`);
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) result[assertId(key, `${nodeName}.inputs key`)] = assertString(raw, `${nodeName}.inputs.${key}`, 2048);
  return result;
}

function parseRequiredInputs(value: unknown, sourcePath: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new SkillGraphError("invalid_graph", `${sourcePath}.required_inputs must be a list of strings`);
  }
  const inputs = value.map((entry, index) => assertId(entry, `${sourcePath}.required_inputs[${index}]`));
  if (new Set(inputs).size !== inputs.length) throw new SkillGraphError("invalid_graph", `${sourcePath}.required_inputs contains duplicate names`);
  return inputs;
}

function parseNodes(document: RawWorkflowDocument): SkillGraphNode[] {
  const rawNodes = document.nodes ?? document.stages;
  if (!Array.isArray(rawNodes) || rawNodes.length === 0 || rawNodes.length > MAX_NODES) throw new SkillGraphError("invalid_graph", "nodes/stages must contain between 1 and 100 entries");
  return rawNodes.map((raw, index) => {
    if (!isRecord(raw)) throw new SkillGraphError("invalid_graph", `nodes[${index}] must be an object`);
    const id = assertId(raw.id, `nodes[${index}].id`);
    const type = raw.type === undefined ? "agent" : raw.type;
    if (type !== "agent") throw new SkillGraphError("invalid_graph", `${id}.type must be agent in v1`);
    const task = assertString(raw.task, `${id}.task`);
    const skill = assertId(typeof raw.skill === "string" ? raw.skill.split("@")[0] : raw.skill, `${id}.skill`);
    const maxVisits = raw.max_visits ?? raw.maxVisits;
    return {
      id,
      type: "agent",
      skill,
      task,
      ...(parseInputs(raw.inputs, id) ? { inputs: parseInputs(raw.inputs, id) } : {}),
      outputs: parseOutputs(raw.outputs, id),
      ...(raw.result_schema === undefined && raw.resultSchema === undefined ? {} : { resultSchema: assertString(raw.result_schema ?? raw.resultSchema, `${id}.result_schema`, 256) }),
      ...(raw.terminal === true ? { terminal: true } : {}),
      ...(maxVisits === undefined ? {} : { maxVisits: assertPositiveInteger(maxVisits, `${id}.max_visits`, 1000) }),
    } satisfies SkillGraphNode;
  });
}

function parseEdges(value: unknown, nodes: SkillGraphNode[], isStages: boolean, rawStages?: unknown[]): SkillGraphEdge[] {
  if (value !== undefined && !Array.isArray(value)) throw new SkillGraphError("invalid_graph", "edges must be a list");
  const edges = (value as unknown[] | undefined)?.map((raw, index) => {
    if (!isRecord(raw)) throw new SkillGraphError("invalid_graph", `edges[${index}] must be an object`);
    const from = assertId(raw.from, `edges[${index}].from`);
    const to = assertId(raw.to, `edges[${index}].to`);
    const id = assertId(raw.id ?? `${from}-to-${to}-${index + 1}`, `edges[${index}].id`);
    const priority = raw.priority === undefined ? 0 : raw.priority;
    if (!Number.isInteger(priority) || (priority as number) < -1_000_000 || (priority as number) > 1_000_000) throw new SkillGraphError("invalid_graph", `${id}.priority must be an integer`);
    const edge: SkillGraphEdge = { id, from, to, priority: priority as number, ...(raw.when === undefined ? {} : { when: assertString(raw.when, `${id}.when`, 2048) }), ...(raw.bind === undefined ? {} : { bind: parseInputs(raw.bind, id) }), ...(raw.loop === undefined ? {} : { loop: parseLoop(raw.loop, id) }) };
    return edge;
  }) ?? [];
  if (isStages && edges.length === 0) {
    const stageNeeds = rawStages?.map((stage) => isRecord(stage) && Array.isArray(stage.needs) ? stage.needs.filter((item): item is string => typeof item === "string") : []);
    for (let index = 0; index < nodes.length; index++) {
      const needs = stageNeeds?.[index] ?? [];
      const sources = needs.length > 0 ? needs : index > 0 ? [nodes[index - 1].id] : [];
      for (const source of sources) edges.push({ id: `${source}-to-${nodes[index].id}`, from: source, to: nodes[index].id, when: 'result.status == "success"', priority: 0 });
    }
  }
  if (edges.length > MAX_EDGES) throw new SkillGraphError("invalid_graph", "edges cannot contain more than 300 entries");
  return edges;
}

function parseLoop(value: unknown, name: string): NonNullable<SkillGraphEdge["loop"]> {
  if (!isRecord(value)) throw new SkillGraphError("invalid_graph", `${name}.loop must be an object`);
  return { id: assertId(value.id, `${name}.loop.id`), maxIterations: assertPositiveInteger(value.max_iterations ?? value.maxIterations, `${name}.loop.max_iterations`, 100) };
}

function parseBudget(value: unknown): SkillGraphBudget {
  const raw = isRecord(value) ? value : {};
  return {
    maxVisits: raw.max_visits === undefined ? 100 : assertPositiveInteger(raw.max_visits, "budgets.max_visits", 10_000),
    maxAgentTurns: raw.max_agent_turns === undefined ? 100 : assertPositiveInteger(raw.max_agent_turns, "budgets.max_agent_turns", 10_000),
    maxDurationMs: raw.max_duration_ms === undefined ? 3_600_000 : assertPositiveInteger(raw.max_duration_ms, "budgets.max_duration_ms", 86_400_000),
  };
}

function validateReferenceSyntax(value: string, name: string): void {
  const references = value.match(/\{\{[^}]+\}\}/g) ?? [];
  for (const reference of references) {
    if (!/^\{\{(?:input:[A-Za-z0-9._-]+|artifact:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+|result:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+)\}\}$/.test(reference)) throw new SkillGraphError("invalid_graph", `${name} contains an invalid reference`);
  }
}

function validateGraph(graph: SkillGraph): void {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  if (nodeIds.size !== graph.nodes.length) throw new SkillGraphError("invalid_graph", "nodes contain duplicate ids");
  if (!nodeIds.has(graph.entry)) throw new SkillGraphError("invalid_graph", `entry node ${graph.entry} does not exist`);
  const edgeIds = new Set<string>();
  const outgoing = new Map<string, SkillGraphEdge[]>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) throw new SkillGraphError("invalid_graph", `duplicate edge id ${edge.id}`);
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) throw new SkillGraphError("invalid_graph", `edge ${edge.id} references an unknown node`);
    edgeIds.add(edge.id);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
    for (const bind of Object.values(edge.bind ?? {})) validateReferenceSyntax(bind, `${edge.id}.bind`);
  }
  for (const node of graph.nodes) {
    for (const input of Object.values(node.inputs ?? {})) validateReferenceSyntax(input, `${node.id}.inputs`);
    const edges = outgoing.get(node.id) ?? [];
    if (node.terminal && edges.length > 0) throw new SkillGraphError("invalid_graph", `terminal node ${node.id} cannot have outgoing edges`);
    if (!node.terminal && edges.length === 0) throw new SkillGraphError("invalid_graph", `node ${node.id} must be terminal or have an outgoing edge`);
    const sorted = [...edges].sort((a, b) => b.priority - a.priority);
    for (let index = 1; index < sorted.length; index++) {
      if (sorted[index - 1].priority === sorted[index].priority && !sorted[index - 1].when && !sorted[index].when) throw new SkillGraphError("invalid_graph", `node ${node.id} has ambiguous unconditional edges`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (nodeId: string): void => {
    if (visiting.has(nodeId)) throw new SkillGraphError("invalid_graph", `implicit cycle reaches ${nodeId}; every cycle must use a loop edge`);
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const edge of outgoing.get(nodeId) ?? []) if (!edge.loop) walk(edge.to);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  walk(graph.entry);
}

function parseWorkflowDocument(raw: unknown, sourcePath: string, sourceScope: SkillGraph["sourceScope"]): SkillGraph {
  if (!isRecord(raw)) throw new SkillGraphError("invalid_graph", `${sourcePath} must contain an object`);
  const document = raw as RawWorkflowDocument;
  const schemaVersion = document.schema_version ?? document.schemaVersion ?? 1;
  if (schemaVersion !== 1) throw new SkillGraphError("invalid_graph", `${sourcePath} has unsupported schema_version`);
  const id = assertId(document.id ?? document.name ?? basename(sourcePath).replace(/\.ya?ml$/i, ""), "workflow id");
  const version = assertPositiveInteger(document.version ?? 1, "workflow version", 1_000_000);
  const execution = isRecord(document.execution) ? document.execution : {};
  const mode = (document.mode ?? execution.mode ?? "agent") as WorkflowMode;
  if (mode !== "agent" && mode !== "cli") throw new SkillGraphError("invalid_graph", "workflow mode must be agent or cli");
  const requiredInputs = parseRequiredInputs(document.required_inputs ?? document.requiredInputs, sourcePath);
  const isStages = Array.isArray(document.stages) && document.nodes === undefined;
  const nodes = parseNodes(document);
  const entry = assertId(document.entry ?? nodes[0].id, "entry");
  const graph: SkillGraph = { schemaVersion: 1, id, version, mode, requiredInputs, entry, nodes, edges: parseEdges(document.edges, nodes, isStages, Array.isArray(document.stages) ? document.stages : undefined), budgets: parseBudget(document.budgets), sourcePath, sourceScope, graphHash: "", skillContracts: [] };
  validateGraph(graph);
  graph.graphHash = sha256Text(canonicalJson({ ...graph, sourcePath: undefined, graphHash: undefined, skillContracts: undefined }));
  return graph;
}

function readSkillSha256(filePath: string): string {
  let text: string;
  try {
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size > MAX_WORKFLOW_BYTES) throw new Error("skill file is not a regular file or is too large");
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new SkillGraphError("missing_skill", `Skill file not found: ${basename(filePath)}: ${message(error)}`);
  }
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function resolveLocalSkillPin(roots: string[], skillPath: string): { filePath: string; baseDir: string } {
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const realRoot = realpathSync(root);
    const candidate = resolve(realRoot, skillPath.replace(/\\/g, "/"));
    if (!pathWithin(realRoot, candidate)) continue;
    const filePath = candidate.toLowerCase().endsWith(`${sep}skill.md`) ? candidate : join(candidate, "SKILL.md");
    if (!existsSync(filePath)) continue;
    const realFilePath = realpathSync(filePath);
    if (pathWithin(realRoot, realFilePath)) return { filePath: realFilePath, baseDir: dirname(realFilePath) };
  }
  throw new SkillGraphError("missing_skill", `SKILL.md not found for path ${skillPath}`);
}

function installedSkillRoots(cwd: string, sourceRoot: string, roots: Required<WorkflowRoots>): string[] {
  const configured = process.env.SKILL_GRAPH_SKILL_PATHS?.split(sep).filter(Boolean) ?? [];
  return [...new Set([
    ...configured,
    join(cwd, ".agents", "skills"),
    join(cwd, ".codex", "skills"),
    join(cwd, "skills"),
    join(sourceRoot, "skills"),
    ...roots.userRoots.map((root) => join(root, "skills")),
  ].map((value) => resolve(value)))];
}

function findInstalledSkill(cwd: string, sourceRoot: string, roots: Required<WorkflowRoots>, id: string): { filePath: string; baseDir: string } | undefined {
  for (const root of installedSkillRoots(cwd, sourceRoot, roots)) {
    const direct = join(root, id, "SKILL.md");
    if (existsSync(direct)) {
      const filePath = realpathSync(direct);
      if (pathWithin(root, filePath)) return { filePath, baseDir: dirname(filePath) };
    }
    if (root.toLowerCase().endsWith(id.toLowerCase()) && existsSync(join(root, "SKILL.md"))) {
      const filePath = realpathSync(join(root, "SKILL.md"));
      if (pathWithin(root, filePath)) return { filePath, baseDir: dirname(filePath) };
    }
  }
  return undefined;
}

function resolveSkillPins(graph: SkillGraph, cwd: string, contracts: SkillContract[], roots: Required<WorkflowRoots>): ResolvedSkillPin[] {
  const sourceRoot = dirname(dirname(graph.sourcePath));
  const skillRoots = graph.sourceScope === "user" ? [sourceRoot] : [sourceRoot, resolve(cwd)];
  const pins: ResolvedSkillPin[] = [];
  for (const node of graph.nodes) {
    if (pins.some((pin) => pin.id === node.skill)) continue;
    const contract = contracts.find((item) => item.id === node.skill);
    if (contract?.path) {
      const local = resolveLocalSkillPin(skillRoots, contract.path);
      pins.push({ id: node.skill, version: contract.version, filePath: local.filePath, baseDir: local.baseDir, sha256: readSkillSha256(local.filePath) });
      continue;
    }
    const skill = findInstalledSkill(cwd, sourceRoot, roots, node.skill);
    if (!skill) throw new SkillGraphError("missing_skill", `Skill ${node.skill} is not installed or pinned`);
    pins.push({ id: node.skill, version: contract?.version ?? 1, filePath: skill.filePath, baseDir: skill.baseDir, sha256: readSkillSha256(skill.filePath) });
  }
  return pins;
}

export async function loadWorkflow(options: LoadWorkflowOptions): Promise<SkillGraph> {
  const cwd = resolve(options.cwd);
  const roots = normaliseRoots(cwd, options.roots);
  const workflowId = assertId(options.workflowId, "workflowId");
  const source = findSource(cwd, workflowId, roots);
  if (!source) throw new SkillGraphError("workflow_not_found", `Workflow ${workflowId} was not found`);
  const graph = parseWorkflowDocument(readYaml(source.path, MAX_WORKFLOW_BYTES), source.path, source.scope);
  const contracts = parseContracts(source);
  for (const node of graph.nodes) {
    const contract = contracts.find((item) => item.id === node.skill);
    if (contracts.length > 0 && !contract) throw new SkillGraphError("invalid_graph", `Skill ${node.skill} is missing from graph/skills.yaml`);
  }
  graph.skillContracts = contracts;
  // Resolve now so execution refuses missing skills before creating a run.
  resolveSkillPins(graph, cwd, contracts, roots);
  return graph;
}

export function resolveGraphSkillPins(graph: SkillGraph, cwd: string, roots?: WorkflowRoots): ResolvedSkillPin[] {
  return resolveSkillPins(graph, resolve(cwd), graph.skillContracts, normaliseRoots(resolve(cwd), roots));
}

export function listWorkflows(cwd: string, roots?: WorkflowRoots): WorkflowSummary[] {
  const resolved = resolve(cwd);
  return listSources(resolved, normaliseRoots(resolved, roots));
}

export function workflowFilePath(cwd: string, workflowId: string, roots?: WorkflowRoots): string | undefined {
  const resolved = resolve(cwd);
  const source = findSource(resolved, workflowId, normaliseRoots(resolved, roots));
  return source?.path;
}

