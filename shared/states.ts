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

export const BETWEEN_TURN_STATES: readonly SessionState[] = [STATES.DORMANT, STATES.IDLE, STATES.COMPLETE, STATES.DONE, STATES.FAILED];

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

export const SIGN_IN_PROMPT_KIND = 'sign-in';
export const API_KEY_PROMPT_KIND = 'api-key';
export const RATE_LIMIT_PROMPT_KIND = 'rate-limit';
export const CHECK_TERMINAL_PROMPT_KIND = 'check-terminal';
export const SIGNED_IN_SIGNAL = 'signed-in';
export const LOGIN_PROMPT_KINDS: ReadonlySet<string> = new Set([SIGN_IN_PROMPT_KIND, API_KEY_PROMPT_KIND]);
export const LOGIN_COMMAND_BY_AGENT: Readonly<Record<string, string>> = Object.freeze({ 'claude-code': '/login' });
