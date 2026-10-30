import type { StageContext } from "../core/types.js";

export function resultTemplate(context: StageContext): Record<string, unknown> {
  return {
    schema_version: 1,
    node_id: context.nodeId,
    visit_id: context.visitId,
    status: "success",
    summary: "What this stage produced",
    artifacts: context.requiredOutputs.map((output) => ({ name: output.name, path: "relative-file.ext" })),
    issues: [],
  };
}

export function buildAgentStagePrompt(context: StageContext): string {
  return [
    `Skill Graph ${context.workflowId} is waiting for node ${context.nodeId}.`,
    `Task: ${context.task}`,
    `Skill: ${context.skill.filePath}`,
    `Inputs: ${JSON.stringify(context.inputs)}`,
    `Required outputs: ${JSON.stringify(context.requiredOutputs)}`,
    `Result path: ${context.resultPath}`,
    `Output directory: ${context.outputDirectory}`,
    "If information is missing or ambiguous, ask the user before guessing.",
    "node_result.json must contain this shape:",
    JSON.stringify(resultTemplate(context), null, 2),
  ].join("\n");
}
