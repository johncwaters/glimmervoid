import { absolutePathReadRule } from '../github/core/team-review-core.ts';
import { LANE_CONFIG_EDIT_DENY_RULES } from '../lanes/core/lane-permissions-core.ts';

const RADAR_SHELL_AND_WEB_DENY = Object.freeze(['Bash', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task']);

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
    denyTools: [...RADAR_SHELL_AND_WEB_DENY, 'Edit', ...LANE_CONFIG_EDIT_DENY_RULES],
    readOnlyPaths: repoPath === null ? [] : [repoPath],
    withPosthogMcp: true,
  };
}

const FIX_POSTURE: RadarToolPosture = Object.freeze({
  allowTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
  denyTools: [...RADAR_SHELL_AND_WEB_DENY, ...LANE_CONFIG_EDIT_DENY_RULES, ...RADAR_WORKFLOW_DENY],
  readOnlyPaths: [],
  withPosthogMcp: false,
});

function radarClaudeArgs(posture: RadarToolPosture, laneArgs: readonly string[]): string[] {
  const readRules = posture.readOnlyPaths.flatMap((readOnlyPath) => ['Read', 'Grep', 'Glob'].map((tool) => absolutePathReadRule(readOnlyPath).replace(/^Read/, tool)));
  return ['-p', ...laneArgs, ...(readRules.length > 0 ? ['--allowedTools', ...readRules] : [])];
}

export { FIX_POSTURE, investigationPosture, radarClaudeArgs };
export type { RadarToolPosture };
