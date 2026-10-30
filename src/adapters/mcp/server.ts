import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SkillGraphEngine, listWorkflows, type JsonObject, type WorkflowRoots } from "../../core/index.js";

const cwd = process.env.SKILL_GRAPH_CWD?.trim() || process.cwd();
const sessionId = process.env.SKILL_GRAPH_SESSION_ID?.trim() || "mcp";
const splitPaths = (value: string | undefined): string[] | undefined => value?.split(process.platform === "win32" ? ";" : ":").filter(Boolean);
const roots: WorkflowRoots = {
  projectRoots: splitPaths(process.env.SKILL_GRAPH_PROJECT_ROOTS),
  userRoots: splitPaths(process.env.SKILL_GRAPH_USER_ROOTS),
};

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text" as const, text: value }] };
}

const server = new McpServer({ name: "skill-graph", version: "0.1.0" });

server.registerTool("workflow_list", {
  description: "List workflow metadata from project and user Skill Graph roots.",
  inputSchema: {},
}, async () => {
  try { return text({ cwd, workflows: listWorkflows(cwd, roots) }); } catch (error) { return errorResult(error); }
});

server.registerTool("workflow_execute", {
  description: "Start one bounded workflow and return the first stage context.",
  inputSchema: {
    workflow_id: z.string().min(1).max(128),
    input: z.record(z.string(), z.unknown()).optional(),
  },
}, async ({ workflow_id, input }) => {
  try {
    const context = await new SkillGraphEngine({ cwd, sessionId, roots }).execute(workflow_id, (input ?? {}) as JsonObject);
    return text({ status: "awaiting_agent", context });
  } catch (error) { return errorResult(error); }
});

server.registerTool("workflow_submit_stage", {
  description: "Submit the current node_result.json and return the next stage context when one exists.",
  inputSchema: {
    run_id: z.string().min(1).max(128),
    node_id: z.string().min(1).max(128),
    visit_id: z.string().min(1).max(128),
    result_path: z.string().min(1).max(2048).optional(),
  },
}, async ({ run_id, node_id, visit_id, result_path }) => {
  try {
    const result = await new SkillGraphEngine({ cwd, sessionId, roots }).submit(run_id, node_id, visit_id, result_path);
    return text(result);
  } catch (error) { return errorResult(error); }
});

server.registerTool("workflow_resume", {
  description: "Resume a paused, blocked, or failed workflow stage.",
  inputSchema: { run_id: z.string().min(1).max(128) },
}, async ({ run_id }) => {
  try {
    const context = await new SkillGraphEngine({ cwd, sessionId, roots }).resume(run_id);
    return text({ status: "awaiting_agent", context });
  } catch (error) { return errorResult(error); }
});

server.registerTool("question", {
  description: "Return a structured user question when a stage needs a choice or free-text value. The host should present it to the user and call again with answer.",
  inputSchema: {
    mode: z.enum(["select", "input"]),
    title: z.string().min(1).max(240),
    message: z.string().max(4000).optional(),
    options: z.array(z.string().min(1).max(512)).min(1).max(50).optional(),
    placeholder: z.string().max(1000).optional(),
    answer: z.string().max(10000).optional(),
  },
}, async ({ mode, title, message, options, placeholder, answer }) => {
  if (answer === undefined) return text({ status: "needs_user", question: { mode, title, message, options, placeholder } });
  return text({ status: "answered", mode, answer });
});

await server.connect(new StdioServerTransport());
