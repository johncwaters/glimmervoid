import { absolutePathReadRule } from '../github/core/team-review-core.ts';
import { LANE_CONFIG_EDIT_DENY_RULES } from '../lanes/core/lane-permissions-core.ts';
import type { LaneAccess } from '../lanes/core/lane-permissions-core.ts';

const RADAR_NOTEBOOK_AND_TASK_DENY = Object.freeze(['NotebookEdit', 'Task']);

const RADAR_WORKFLOW_DENY = Object.freeze(['Edit(.github/workflows/**)', 'Write(.github/workflows/**)', 'Edit(.git)', 'Write(.git)']);

interface RadarToolPosture {
  allowTools: readonly string[];
  denyTools: readonly string[];
  readOnlyPaths: readonly string[];
  withPosthogMcp: boolean;
}

function investigationPosture(repoPath: string | null): RadarToolPosture {
  return {
    allowTools: ['Read', 'Grep', 'Glob', 'Write'],
    denyTools: [...RADAR_NOTEBOOK_AND_TASK_DENY, 'Edit', ...LANE_CONFIG_EDIT_DENY_RULES],
    readOnlyPaths: repoPath === null ? [] : [repoPath],
    withPosthogMcp: true,
  };
}

const FIX_POSTURE: RadarToolPosture = Object.freeze({
  allowTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
  denyTools: [...RADAR_NOTEBOOK_AND_TASK_DENY, ...LANE_CONFIG_EDIT_DENY_RULES, ...RADAR_WORKFLOW_DENY],
  readOnlyPaths: [],
  withPosthogMcp: false,
});

function withLaneAccessTools(posture: RadarToolPosture, access: Pick<LaneAccess, 'isOpen' | 'tools'>): RadarToolPosture {
  return {
    ...posture,
    allowTools: [...posture.allowTools, ...access.tools],
    denyTools: [...posture.denyTools, ...(access.isOpen ? [] : ['Bash'])],
  };
}

function radarClaudeArgs(posture: RadarToolPosture, laneArgs: readonly string[]): string[] {
  const readRules = posture.readOnlyPaths.flatMap((readOnlyPath) => ['Read', 'Grep', 'Glob'].map((tool) => absolutePathReadRule(readOnlyPath).replace(/^Read/, tool)));
  return ['-p', ...laneArgs, ...(readRules.length > 0 ? ['--allowedTools', ...readRules] : [])];
}

export { FIX_POSTURE, investigationPosture, radarClaudeArgs, withLaneAccessTools };
export type { RadarToolPosture };
