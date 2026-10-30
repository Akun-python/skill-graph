import { readFileSync } from "node:fs";
import { SkillGraphEngine, listWorkflows, type JsonObject, type WorkflowRoots } from "./core/index.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function rootsFromEnv(): WorkflowRoots {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const split = (value: string | undefined) => value?.split(delimiter).filter(Boolean);
  return { projectRoots: split(process.env.SKILL_GRAPH_PROJECT_ROOTS), userRoots: split(process.env.SKILL_GRAPH_USER_ROOTS) };
}

function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "list";
  const cwd = option(args, "--cwd") ?? process.env.SKILL_GRAPH_CWD ?? process.cwd();
  const roots = rootsFromEnv();
  if (command === "mcp") { await import("./adapters/mcp/server.js"); return; }
  if (command === "list") { print({ cwd, workflows: listWorkflows(cwd, roots) }); return; }
  const engine = new SkillGraphEngine({ cwd, sessionId: process.env.SKILL_GRAPH_SESSION_ID ?? "cli", roots });
  if (command === "run") {
    const workflowId = args[1];
    if (!workflowId) throw new Error("Usage: skill-graph run <workflow-id> [JSON input] [--input-file path] [--cwd path]");
    const inputFile = option(args, "--input-file");
    const raw = inputFile
      ? JSON.parse(readFileSync(inputFile, "utf8"))
      : args[2] && !args[2].startsWith("--") ? JSON.parse(args[2]) : {};
    print(await engine.execute(workflowId, raw as JsonObject));
    return;
  }
  if (command === "context") {
    if (!args[1]) throw new Error("Usage: skill-graph context <run-id> [--cwd path]");
    print(await engine.stageContext(args[1]));
    return;
  }
  if (command === "resume") {
    if (!args[1]) throw new Error("Usage: skill-graph resume <run-id> [--cwd path]");
    print(await engine.resume(args[1]));
    return;
  }
  if (command === "submit") {
    if (!args[1] || !args[2] || !args[3]) throw new Error("Usage: skill-graph submit <run-id> <node-id> <visit-id> [result-path] [--cwd path]");
    print(await engine.submit(args[1], args[2], args[3], args[4] && !args[4].startsWith("--") ? args[4] : undefined));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
