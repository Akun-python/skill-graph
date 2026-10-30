import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import lockfile from "proper-lockfile";
import { isRecord } from "./json.js";
import type { GraphEvent, WorkflowManifest, WorkflowRunState } from "./types.js";
import { SkillGraphError } from "./types.js";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_BYTES = 64 * 1024;
const QUEUE_KEY = Symbol.for("pi-web:skill-graph-state-queue");

export interface RunPaths {
  root: string;
  manifest: string;
  state: string;
  events: string;
}

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new SkillGraphError("run_not_found", "Invalid run id");
}

export function getRunPaths(cwd: string, runId: string): RunPaths {
  assertRunId(runId);
  const root = join(resolve(cwd), ".skill-workflows", "runs", runId);
  return { root, manifest: join(root, "manifest.json"), state: join(root, "state.json"), events: join(root, "events.jsonl") };
}

function parseJson<T>(path: string, value: unknown): T {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed as T;
  } catch (error) {
    throw new SkillGraphError("storage_error", `Could not read ${value}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function ensureStateFile(path: string): void {
  if (!existsSync(path)) writeFileSync(path, "{}\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function assertRunRootInsideCwd(paths: RunPaths, cwd: string): void {
  try {
    const root = realpathSync(paths.root);
    const cwdRoot = realpathSync(cwd);
    const rel = relative(cwdRoot, root);
    if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) throw new SkillGraphError("storage_error", "Workflow run directory escapes the session cwd");
  } catch (error) {
    if (error instanceof SkillGraphError) throw error;
    throw new SkillGraphError("storage_error", `Could not resolve workflow run directory: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const LOCK_OPTIONS = {
  realpath: false,
  stale: 10_000,
  retries: { retries: 10, factor: 2, minTimeout: 25, maxTimeout: 500 },
};

const queues = new Map<string, Promise<void>>();

async function serializeByKey<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  queues.set(key, current);
  await previous;
  try { return await task(); } finally {
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}

function writePrivateFileAtomicSync(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  try { renameSync(temporary, path); } catch (error) {
    try { writeFileSync(path, contents, { encoding: "utf8", mode: 0o600 }); } finally {
      try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
    }
    if (error instanceof Error && !existsSync(path)) throw error;
  }
}

async function withRunLock<T>(paths: RunPaths, task: () => Promise<T> | T): Promise<T> {
  return serializeByKey(`${String(QUEUE_KEY)}:${paths.state}`, async () => {
    ensureStateFile(paths.state);
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(paths.state, LOCK_OPTIONS);
      return await task();
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ELOCKED") throw new SkillGraphError("storage_error", "Another process is writing this workflow run");
      throw error;
    } finally {
      await release?.().catch(() => undefined);
    }
  });
}

function ensureRun(paths: RunPaths): void {
  if (!existsSync(paths.state) || !existsSync(paths.manifest)) throw new SkillGraphError("run_not_found", "Workflow run not found");
}

export async function createRun(manifest: WorkflowManifest, state: WorkflowRunState): Promise<void> {
  const paths = getRunPaths(manifest.cwd, manifest.runId);
  mkdirSync(paths.root, { recursive: true });
  assertRunRootInsideCwd(paths, manifest.cwd);
  await withRunLock(paths, () => {
    if (existsSync(paths.manifest)) throw new SkillGraphError("run_busy", `Run ${manifest.runId} already exists`);
    mkdirSync(join(paths.root, "stages"), { recursive: true });
    writePrivateFileAtomicSync(paths.manifest, JSON.stringify(manifest, null, 2) + "\n");
    writePrivateFileAtomicSync(paths.state, JSON.stringify(state, null, 2) + "\n");
    writeFileSync(paths.events, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  });
}

export async function readRun(cwd: string, runId: string): Promise<{ manifest: WorkflowManifest; state: WorkflowRunState }> {
  const paths = getRunPaths(cwd, runId);
  assertRunRootInsideCwd(paths, cwd);
  ensureRun(paths);
  try {
    if (readFileSync(paths.state).byteLength > MAX_STATE_BYTES) throw new Error("state is too large");
    const manifest = parseJson<WorkflowManifest>(paths.manifest, "manifest");
    const state = parseJson<WorkflowRunState>(paths.state, "state");
    if (!isRecord(manifest) || manifest.schemaVersion !== 1 || typeof manifest.runId !== "string" || !isRecord(state) || state.schemaVersion !== 1 || state.runId !== manifest.runId || typeof state.status !== "string") {
      throw new SkillGraphError("storage_error", "Workflow manifest or state has an invalid shape");
    }
    return { manifest, state };
  } catch (error) {
    if (error instanceof SkillGraphError) throw error;
    throw new SkillGraphError("storage_error", `Workflow state is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function updateRun<T>(cwd: string, runId: string, edit: (value: { manifest: WorkflowManifest; state: WorkflowRunState; paths: RunPaths }) => Promise<{ state: WorkflowRunState; result: T }> | { state: WorkflowRunState; result: T }): Promise<T> {
  const paths = getRunPaths(cwd, runId);
  assertRunRootInsideCwd(paths, cwd);
  return withRunLock(paths, async () => {
    ensureRun(paths);
    const manifest = parseJson<WorkflowManifest>(paths.manifest, "manifest");
    const state = parseJson<WorkflowRunState>(paths.state, "state");
    const changed = await edit({ manifest, state, paths });
    writePrivateFileAtomicSync(paths.state, JSON.stringify(changed.state, null, 2) + "\n");
    return changed.result;
  });
}

export async function appendRunEvent(cwd: string, runId: string, event: GraphEvent): Promise<void> {
  const paths = getRunPaths(cwd, runId);
  assertRunRootInsideCwd(paths, cwd);
  await withRunLock(paths, () => {
    ensureRun(paths);
    const line = JSON.stringify(event);
    if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) throw new SkillGraphError("storage_error", "Workflow event is too large");
    appendFileSync(paths.events, `${line}\n`, { encoding: "utf8" });
  });
}

export function readRunEvents(cwd: string, runId: string, limit = 100): GraphEvent[] {
  const paths = getRunPaths(cwd, runId);
  assertRunRootInsideCwd(paths, cwd);
  ensureRun(paths);
  const count = Math.max(1, Math.min(500, Math.trunc(limit)));
  const lines = readFileSync(paths.events, "utf8").split(/\r?\n/).filter(Boolean).slice(-count);
  const events: GraphEvent[] = [];
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as unknown;
      if (isRecord(value)) events.push(value as unknown as GraphEvent);
    } catch {
      // A partial final line is ignored; state.json remains authoritative.
    }
  }
  return events;
}

export function normalizeRunState(value: unknown): WorkflowRunState | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.runId !== "string" || typeof value.status !== "string") return undefined;
  return value as unknown as WorkflowRunState;
}
