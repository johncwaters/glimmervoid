import type { SessionState } from '#shared/states.ts';
import { BADGE_LABELS, STATES } from '#shared/states.ts';

export interface StatusLegendEntry {
  state: SessionState;
  awaitingBackgroundTasks: boolean;
  label: string;
  meaning: string;
}

const entry = (state: SessionState, meaning: string, awaitingBackgroundTasks = false): StatusLegendEntry => ({
  state,
  awaitingBackgroundTasks,
  label: awaitingBackgroundTasks ? 'Monitoring' : BADGE_LABELS[state],
  meaning,
});

export const STATUS_LEGEND: readonly StatusLegendEntry[] = Object.freeze([
  entry(STATES.DORMANT, 'Not started yet.'),
  entry(STATES.INITIALIZING, 'Setting up the worktree and launching the agent.'),
  entry(STATES.STARTING, 'The agent is booting.'),
  entry(STATES.RUNNING, 'The agent is mid-turn.'),
  entry(STATES.RUNNING, 'The turn ended but background tasks or sub-agents are still running.', true),
  entry(STATES.WAITING, 'Waiting on a permission prompt or your answer.'),
  entry(STATES.IDLE, 'Ready for the next prompt.'),
  entry(STATES.COMPLETE, 'Finished a turn you have not looked at yet.'),
  entry(STATES.DONE, 'The agent process ended.'),
  entry(STATES.FAILED, 'The agent failed to start or crashed.'),
]);
