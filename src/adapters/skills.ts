import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { StageContext } from "../core/types.js";

const MAX_SKILL_BYTES = 1024 * 1024;

export interface LoadedSkill {
  filePath: string;
  baseDir: string;
  content: string;
}

export function loadSkill(filePath: string): LoadedSkill {
  const resolved = resolve(filePath);
  const stats = statSync(resolved);
  if (!stats.isFile() || stats.size > MAX_SKILL_BYTES) throw new Error(`Skill is not a regular file or is too large: ${resolved}`);
  return { filePath: resolved, baseDir: dirname(resolved), content: readFileSync(resolved, "utf8") };
}

export function loadStageSkill(context: StageContext): LoadedSkill {
  return loadSkill(context.skill.filePath);
}

export function buildSkillPrompt(context: StageContext, skill = loadStageSkill(context)): string {
  return [
    `Active workflow: ${context.workflowId}`,
    `Active node: ${context.nodeId}`,
    `Task: ${context.task}`,
    `Inputs: ${JSON.stringify(context.inputs)}`,
    `Skill file: ${skill.filePath}`,
    "Read and follow the skill instructions below for this stage only:",
    skill.content,
    `Write declared artifacts below ${context.outputDirectory}.`,
    `Write node_result.json to ${context.resultPath} and submit the stage after validation.`,
  ].join("\n\n");
}
