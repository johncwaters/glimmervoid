import { teamReviewStatusView } from './team-review-store.ts';
import type { TeamReviewAction, TeamReviewStatus as TeamReviewStatusType } from '#shared/contracts/team-review.ts';
import { createPollAgoTicker } from '../poll-ago.ts';
import type { ReviewDetailKeyAction } from './review-queue-core.ts';

type SettleAction = (isDone: boolean, text: string, tone?: 'ok' | 'error') => void;

interface ActionDetailHandle {
  signature: string;
  flaggedSignature?: string;
  isTouched?: () => boolean;
  element: HTMLElement;
  settle: SettleAction;
  showReceipt?: (text: string, tone?: 'ok' | 'error') => void;
  clearReceipt?: () => void;
  runKey?: (action: ReviewDetailKeyAction) => boolean;
}

interface PendingAction {
  requestId: string;
  action: TeamReviewAction;
  outcomeText: string;
  origin: DetailOrigin;
  capturedOrder: string[];
  pullRequest: string;
  timer: number;
  settle?: SettleAction;
}

type DetailOrigin = 'ready' | 'other';

let _view: TeamReviewStatusType | null = teamReviewStatusView();

let _root: HTMLElement | null = null;

let _postedReceipt: string | null = null;

let _queueHooks: TeamReviewQueueHooks | null = null;

const _sessionOpenByKey = new Map<string, { requestId: string | null; timer: number; text: string; tone: 'busy' | 'error' }>();

const _progressTicker = createPollAgoTicker(() => _root);

const _detailProgressTicker = createPollAgoTicker(() => _root);

const _ageTicker = createPollAgoTicker(() => _root);

const _readyDetails = new Map<string, ActionDetailHandle>();

const _otherDetails = new Map<string, ActionDetailHandle>();

const _pendingActions = new Map<string, PendingAction>();

interface TeamReviewQueueHooks {
  onChange: () => void;
  captureTurnOrder: () => string[];
  onAdvance: (actedReviewKey: string, capturedOrder: readonly string[]) => void;
}

function setView(next: typeof _view): void {
  _view = next;
}

function setRoot(next: typeof _root): void {
  _root = next;
}

function setPostedReceipt(next: typeof _postedReceipt): void {
  _postedReceipt = next;
}

function setQueueHooks(next: typeof _queueHooks): void {
  _queueHooks = next;
}

export { _ageTicker, _detailProgressTicker, _otherDetails, _pendingActions, _postedReceipt, _progressTicker, _queueHooks, _readyDetails, _root, _sessionOpenByKey, _view, setPostedReceipt, setQueueHooks, setRoot, setView };
export type { ActionDetailHandle, DetailOrigin, SettleAction, TeamReviewQueueHooks };
