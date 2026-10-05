import type { FitAddon } from '@xterm/addon-fit';
import type { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';
import type { PlanReviewState } from '#shared/contracts/plan-review.ts';
import type { PendingPromptDetail } from '#shared/contracts/session.ts';
import type { createPlanFace } from '../plan/plan-face.ts';
import type { SessionCardFace } from './face-core.ts';
import type { TerminalGrid } from './grid-core.ts';

export type SessionCardElement = HTMLDivElement & { _cardHostClass?: string };

export type PlanFaceController = ReturnType<typeof createPlanFace>;

export interface SessionUi {
  term: Terminal | null;
  fitAddon: FitAddon | null;
  webglAddon: WebglAddon | null;
  needsWebGLReload: boolean;
  webglAttachedWithoutLayout: boolean;
  dataWs: WebSocket | null;
  card: SessionCardElement;
  nameEl: HTMLSpanElement;
  taskTitleEl: HTMLSpanElement;
  taskTitle: string | null;
  taskTitleIsCustom: boolean;
  titleTargetEl?: HTMLElement | null;
  elapsedEl: HTMLSpanElement;
  path: string;
  stateSince: number;
  restartMenu: HTMLDivElement;
  termWrap: HTMLDivElement;
  btnDebug: HTMLButtonElement;
  btnRestart: HTMLButtonElement;
  btnRestartFresh: HTMLButtonElement;
  btnRestartMenu: HTMLButtonElement;
  btnResume: HTMLButtonElement;
  btnTrace: HTMLButtonElement;
  btnPlan: HTMLButtonElement;
  btnRemove: HTMLButtonElement;
  debugOverlay: HTMLDivElement | null;
  debugOpen: boolean;
  abortController: AbortController;
  currentState: string;
  agent?: string | null;
  face: SessionCardFace;
  isBorrowed: boolean;
  hasPlan: boolean;
  pendingPromptKind: string | null;
  pendingPromptDetail: PendingPromptDetail | null;
  planReviewState: PlanReviewState;
  planFace: PlanFaceController;
  effectiveBase?: string;
  activeAgents?: number;
  awaitingBackgroundTasks?: boolean;
  hasEndedTurn: boolean;
  resizeObserver?: ResizeObserver;
  ptySize?: TerminalGrid | null;

  renameTargetEl?: HTMLElement | null;

  _activity?: 'active' | 'quiet' | undefined;
  _activityGate?: number;
  _lastOutputAt?: number;

  _dataWsRetryAttempt?: number;
  _inputQueue?: string[];
  _syncGrid?: (options?: { isActivationEdge?: boolean }) => void;
  _resetGridClaim?: () => void;
  _retryOwedGridClaim?: () => void;
  _syncGridOnEngagementEdge?: () => void;
  _setActiveViewer?: (isActive: boolean) => void;
  _resetSoftKeyboardBuffer?: () => void;
  _ensureTerminalReady?: () => void;
  _setBorrowed?: (isBorrowed: boolean) => void;
  _showPreferredFace?: () => void;
  _showTerminalFace?: () => void;
}

export const sessionUIs = new Map<string, SessionUi>();

export function sessionName(ui: SessionUi) {
  return ui.card?.dataset.session || ui.nameEl?.textContent || '';
}

export function sessionIdOf(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

export function findSessionUi(value: unknown): SessionUi | undefined {
  return typeof value === 'string' ? sessionUIs.get(value) : undefined;
}

export const container = document.getElementById('sessions-container');
export const aggregateEl = document.getElementById('aggregate-status');
