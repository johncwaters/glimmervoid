export const OUTCOME_NAMES = [
  'notifyDelivered',
  'notifyFailed',
  'telegramDelivered',
  'telegramFailed',
  'hookRejected403',
  'hookRejected404',
  'hookRejectedNonLoopback',
  'controlWsOpened',
  'controlWsClosed',
  'dataWsOpened',
  'dataWsClosed',
] as const;

export type OutcomeName = (typeof OUTCOME_NAMES)[number];
export type OutcomeRecorder = (name: OutcomeName) => void;
