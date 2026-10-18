import type { CoherenceCheckStage, CoherenceCheckStageId, ProjectCoherenceCheckResult } from '#shared/contracts/coherence.ts';

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

export function coherenceCheckStageText(stage: CoherenceCheckStage): string {
  return `${stage.status.toUpperCase()} ${coherenceCheckStageLabel(stage.id)}`;
}

export function coherenceCheckSummary(stages: readonly CoherenceCheckStage[]): string {
  const failedCount = stages.filter((stage) => stage.status === 'fail').length;
  if (failedCount > 0) return `${failedCount} failed`;
  return 'All stages passed';
}

export function coherenceCheckStatus(isPending: boolean, reply?: ProjectCoherenceCheckResult): string {
  if (isPending) return 'Checking Coherence';
  if (!reply) return '';
  if (!reply.ok && reply.error) return `Check failed: ${reply.error}`;
  return coherenceCheckSummary(reply.stages);
}
