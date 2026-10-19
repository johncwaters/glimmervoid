import type { CoherenceCheckStage, CoherenceCheckStageId } from '#shared/contracts/coherence.ts';

const STAGE_LABELS = {
  setting: 'Setting',
  install: 'Install',
  'hooks-claude': 'Claude hooks',
  'hooks-codex': 'Codex hooks',
  'session-start': 'Session start',
  journal: 'Journal',
  'next-action': 'Next action',
  readings: 'Readings',
  'live-sessions': 'Live sessions',
} satisfies Record<CoherenceCheckStageId, string>;

export function coherenceCheckStageLabel(stageId: string): string {
  if (!Object.hasOwn(STAGE_LABELS, stageId)) return stageId;
  return STAGE_LABELS[stageId as CoherenceCheckStageId];
}

export function coherenceCheckSummary(stages: readonly CoherenceCheckStage[]): string {
  const failedCount = stages.filter((stage) => stage.status === 'fail').length;
  if (failedCount > 0) return `${failedCount} failed`;
  return 'All stages passed';
}
