import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getRunPaths } from "./state-store.js";
import { asJsonObject, isRecord, sha256Bytes, validateJsonSchema } from "./json.js";
import type { ArtifactRecord, JsonObject, NodeResult, SkillGraph, SkillGraphNode } from "./types.js";
import { SkillGraphError } from "./types.js";

const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

function pathWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeRelativePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || isAbsolute(value) || /[\0:]/.test(value)) throw new SkillGraphError("invalid_artifact", `${name} must be a relative path`);
  const normalized = value.replace(/\\/g, "/");
  if (normalized.split("/").some((part) => part === ".." || part === "" || part === ".")) throw new SkillGraphError("invalid_artifact", `${name} contains an invalid path segment`);
  return normalized;
}

function schemaPath(graph: SkillGraph, ref: string): string {
  const root = dirname(dirname(graph.sourcePath));
  const path = resolve(root, ref);
  if (!pathWithin(root, path)) throw new SkillGraphError("invalid_artifact", `Schema path ${ref} escapes the workflow package`);
  return path;
}

function loadSchema(graph: SkillGraph, ref: string): unknown {
  const path = schemaPath(graph, ref);
  if (!existsSync(path)) throw new SkillGraphError("invalid_artifact", `Schema file not found: ${ref}`);
  try {
    const root = realpathSync(dirname(dirname(graph.sourcePath)));
    const realPath = realpathSync(path);
    if (!pathWithin(root, realPath)) throw new Error("schema follows a link outside the workflow package");
    return JSON.parse(readFileSync(realPath, "utf8")) as unknown;
  } catch (error) {
    throw new SkillGraphError("invalid_artifact", `Schema ${ref} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function visitPaths(cwd: string, runId: string, nodeId: string, visitId: string): { root: string; result: string; outputs: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(nodeId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(visitId)) throw new SkillGraphError("invalid_artifact", "Invalid node or visit id");
  const root = join(getRunPaths(cwd, runId).root, "stages", nodeId, "visits", visitId);
  return { root, result: join(root, "node_result.json"), outputs: join(root, "outputs") };
}

export function ensureVisitDirectories(cwd: string, runId: string, nodeId: string, visitId: string): { result: string; outputs: string } {
  const paths = visitPaths(cwd, runId, nodeId, visitId);
  mkdirSync(paths.outputs, { recursive: true });
  return paths;
}

function parseNodeResult(value: unknown): NodeResult {
  if (!isRecord(value) || value.schema_version !== 1 || typeof value.node_id !== "string" || typeof value.visit_id !== "string" || typeof value.status !== "string" || typeof value.summary !== "string" || !Array.isArray(value.artifacts) || !Array.isArray(value.issues)) {
    throw new SkillGraphError("invalid_result", "node_result.json must contain schema_version: 1, node_id, visit_id, status, summary, artifacts: [], and issues: []");
  }
  if (!["success", "blocked", "needs_input", "failed"].includes(value.status)) throw new SkillGraphError("invalid_result", "node_result.json has an invalid status");
  const artifacts = value.artifacts.map((item, index) => {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.path !== "string") throw new SkillGraphError("invalid_result", `artifacts[${index}] must contain name and path`);
    return { name: item.name, path: item.path, ...(typeof item.schema === "string" ? { schema: item.schema } : {}) };
  });
  const issues = value.issues.map((item, index): NodeResult["issues"][number] => {
    if (!isRecord(item) || typeof item.message !== "string") throw new SkillGraphError("invalid_result", `issues[${index}] must contain message`);
    const severity = item.severity === "info" || item.severity === "warning" || item.severity === "error" ? item.severity : undefined;
    return { message: item.message, ...(typeof item.code === "string" ? { code: item.code } : {}), ...(severity ? { severity } : {}) };
  });
  const result: NodeResult = {
    schemaVersion: 1,
    nodeId: value.node_id,
    visitId: value.visit_id,
    status: value.status as NodeResult["status"],
    summary: value.summary,
    artifacts,
    issues,
    ...(typeof value.decision === "string" ? { decision: value.decision } : {}),
    ...(isRecord(value.metrics) ? { metrics: asJsonObject(value.metrics, "metrics") } : {}),
    ...(Array.isArray(value.evidence) ? { evidence: value.evidence.filter((item): item is { artifact: string; claim: string } => isRecord(item) && typeof item.artifact === "string" && typeof item.claim === "string") } : {}),
    ...(isRecord(value.next) && typeof value.next.requested === "string" ? { next: { requested: value.next.requested } } : {}),
  };
  return result;
}

export function readNodeResult(cwd: string, runId: string, node: SkillGraphNode, visitId: string, graph: SkillGraph, requestedPath?: string): { result: NodeResult; paths: ReturnType<typeof visitPaths>; records: ArtifactRecord[] } {
  const paths = visitPaths(cwd, runId, node.id, visitId);
  const resultPath = requestedPath === undefined
    ? paths.result
    : requestedPath === paths.result
      ? paths.result
      : resolve(paths.root, safeRelativePath(requestedPath, "result_path"));
  if (resultPath !== paths.result || !existsSync(resultPath)) throw new SkillGraphError("invalid_result", "The result path must be the current visit's node_result.json");
  let result: NodeResult;
  try {
    const stats = statSync(resultPath);
    if (!stats.isFile() || stats.size > MAX_RESULT_BYTES) throw new Error("result is not a regular file or is too large");
    result = parseNodeResult(JSON.parse(readFileSync(resultPath, "utf8")));
  } catch (error) {
    if (error instanceof SkillGraphError) throw error;
    throw new SkillGraphError("invalid_result", `Could not read node_result.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.nodeId !== node.id || result.visitId !== visitId) throw new SkillGraphError("stale_stage", "node_result.json does not belong to the current visit");
  if (!pathWithin(paths.root, resultPath)) throw new SkillGraphError("invalid_result", "Result path escapes the visit directory");
  const declarations = new Map(node.outputs.map((output) => [output.name, output]));
  const names = new Set<string>();
  const records: ArtifactRecord[] = [];
  for (const artifact of result.artifacts) {
    if (names.has(artifact.name)) throw new SkillGraphError("invalid_artifact", `Artifact ${artifact.name} is declared more than once`);
    names.add(artifact.name);
    const declaration = declarations.get(artifact.name);
    if (!declaration) throw new SkillGraphError("invalid_artifact", `Artifact ${artifact.name} is not declared by node ${node.id}`);
    const relativePath = safeRelativePath(artifact.path, `${artifact.name}.path`);
    const target = resolve(paths.outputs, relativePath);
    if (!pathWithin(paths.outputs, target) || !existsSync(target)) throw new SkillGraphError("invalid_artifact", `Artifact ${artifact.name} is outside the current output directory`);
    const realTarget = realpathSync(target);
    const realRunRoot = realpathSync(paths.root);
    const realOutput = realpathSync(paths.outputs);
    if (!pathWithin(realRunRoot, realOutput) || !pathWithin(realOutput, realTarget)) throw new SkillGraphError("invalid_artifact", `Artifact ${artifact.name} follows a link outside the run directory`);
    const stats = statSync(realTarget);
    if (!stats.isFile() || stats.size > MAX_ARTIFACT_BYTES) throw new SkillGraphError("invalid_artifact", `Artifact ${artifact.name} is not a regular file or is too large`);
    const bytes = readFileSync(realTarget);
    const schemaRef = artifact.schema ?? declaration.schema;
    if (schemaRef) {
      let jsonValue: unknown;
      try { jsonValue = JSON.parse(bytes.toString("utf8")); } catch { throw new SkillGraphError("invalid_artifact", `Artifact ${artifact.name} is not valid JSON for schema validation`); }
      const issues = validateJsonSchema(jsonValue, loadSchema(graph, schemaRef), `$[${artifact.name}]`);
      if (issues.length > 0) throw new SkillGraphError("invalid_artifact", `Artifact ${artifact.name} does not match ${schemaRef}: ${issues[0].message}`);
    }
    records.push({ name: artifact.name, relativePath, ...(schemaRef ? { schema: schemaRef } : {}), sha256: sha256Bytes(bytes), bytes: bytes.byteLength, nodeId: node.id, visitId, promoted: true, verifiedAt: new Date().toISOString() });
  }
  for (const output of node.outputs) if (output.required && !names.has(output.name)) throw new SkillGraphError("invalid_artifact", `Required artifact ${output.name} is missing`);
  if (node.resultSchema) {
    const issues = validateJsonSchema(result as unknown as JsonObject, loadSchema(graph, node.resultSchema), "$");
    if (issues.length > 0) throw new SkillGraphError("invalid_result", `Node result does not match ${node.resultSchema}: ${issues[0].message}`);
  }
  return { result, paths, records };
}
