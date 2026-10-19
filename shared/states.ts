export const STATES = Object.freeze({
  DORMANT:      'DORMANT',
  INITIALIZING: 'INITIALIZING',
  STARTING:     'STARTING',
  RUNNING:      'RUNNING',
  WAITING:      'WAITING',
  IDLE:         'IDLE',
  COMPLETE:     'COMPLETE',
  DONE:         'DONE',
  FAILED:       'FAILED',
} as const);

export type SessionState = (typeof STATES)[keyof typeof STATES];

export const BADGE_LABELS: Readonly<Record<SessionState, string>> = Object.freeze({
  [STATES.DORMANT]:      'Dormant',
  [STATES.INITIALIZING]: 'Starting',
  [STATES.STARTING]:     'Starting',
  [STATES.RUNNING]:      'Working',
  [STATES.WAITING]:      'Needs Input',
  [STATES.IDLE]:         'Idle',
  [STATES.COMPLETE]:     'Complete',
  [STATES.DONE]:         'Exited',
  [STATES.FAILED]:       'Failed',
});

export const KILLABLE_STATES: readonly SessionState[] = Object.freeze([
  STATES.INITIALIZING,
  STATES.STARTING,
  STATES.RUNNING,
  STATES.WAITING,
  STATES.IDLE,
  STATES.COMPLETE,
]);
export const RESTARTABLE_STATES: readonly SessionState[] = Object.freeze([STATES.DONE, STATES.FAILED]);

export const MERGEABLE_LIVE_STATES: readonly SessionState[] = Object.freeze([STATES.WAITING, STATES.IDLE, STATES.COMPLETE]);
