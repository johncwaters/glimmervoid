import type { Rect } from '#shared/whiteboard-layout-core.ts';
import type { ActivityBeat, ChatPhase } from '../chat/chat-activity-core.ts';
import type { CardPlacement, CardSize } from './agent-card-place-core.ts';

export const MENU_TEXT = 'Agent menu';
export const RESTART_TEXT = 'Restart';
export const ACCOUNT_TEXT = 'Model and account';
export const CLOSE_TEXT = 'Close';
export const PICK_AGENT_TEXT = 'Pick agent';
export const CARET_ICON_PATH = 'M4 6l4 4 4-4';
export const FLAG_ICON_PATH = 'M4 14V2.5h8l-2 3 2 3H4';

const BUSY_PHASES: ReadonlySet<ChatPhase> = new Set(['starting', 'working', 'monitoring']);

export interface AgentCardCoreModel {
  sessionId: string;
  name: string;
  agentId: string | null;
  isMain: boolean;
  repoLabel: string | null;
  isBranch: boolean;
  boxIds: readonly string[];
  phase: ChatPhase;
  beat: ActivityBeat | null;
  digest: string | null;
  misfit: string | null;
  failure: string | null;
  canPickAgent: boolean;
  isAsking: boolean;
  isOpened: boolean;
}

interface PaintedAgentCard<Model extends AgentCardCoreModel> {
  sessionId: string;
  model: Model;
  boxRect: Rect | null;
  isCardShrunk: boolean;
  isWireHidden: boolean;
}

interface AgentCardsCoreState {
  openMenuSessionId: string | null;
  refusalBySessionId: Readonly<Record<string, string>>;
  placementBySessionId: Readonly<Record<string, CardPlacement>>;
  cardSizeBySessionId: Readonly<Record<string, CardSize>>;
  mapBoundsRevision: number;
}

export const INITIAL_AGENT_CARDS_STATE: AgentCardsCoreState = {
  openMenuSessionId: null,
  refusalBySessionId: {},
  placementBySessionId: {},
  cardSizeBySessionId: {},
  mapBoundsRevision: 0,
};

interface CardDisplayFlags {
  isNameHidden: boolean;
  isRepoButtonHidden: boolean;
  isMoreButtonHidden: boolean;
  isCloseItemHidden: boolean;
  isDigestHidden: boolean;
  isMisfitHidden: boolean;
  isFailureHidden: boolean;
  isPickAgentHidden: boolean;
  isRefusalHidden: boolean;
  isFlagged: boolean;
  isFailed: boolean;
  isAsking: boolean;
  isMenuOpen: boolean;
  refusalText: string;
}

interface ChatCardAnswerDetail {
  cardId: string;
  action: string;
  value: string;
}

export function isBusyPhase(phase: ChatPhase): boolean {
  return BUSY_PHASES.has(phase);
}

export function isShrunk(model: Pick<AgentCardCoreModel, 'isBranch' | 'isOpened' | 'phase' | 'isAsking' | 'failure'>): boolean {
  return model.isBranch && !model.isOpened && !isBusyPhase(model.phase) && !model.isAsking && model.failure === null;
}

export function faceClassNamesOf(
  model: Pick<AgentCardCoreModel, 'isMain' | 'isBranch'>,
  extraClasses: readonly string[] = [],
): string {
  return ['bs-face', model.isMain ? 'bs-face-main' : '', model.isBranch ? 'bs-face-branch' : '', ...extraClasses]
    .filter(Boolean)
    .join(' ');
}

export function faceAriaLabelOf(name: string): string {
  return `Message ${name}`;
}

export function shrunkAriaLabelOf(name: string): string {
  return `Open ${name}`;
}

export function cardDisplayOf(
  model: AgentCardCoreModel,
  isMenuOpen: boolean,
  refusalText: string | null,
): CardDisplayFlags {
  return {
    isNameHidden: model.repoLabel !== null,
    isRepoButtonHidden: model.repoLabel === null,
    isMoreButtonHidden: model.repoLabel !== null,
    isCloseItemHidden: !model.isBranch,
    isDigestHidden: model.digest === null,
    isMisfitHidden: model.misfit === null,
    isFailureHidden: model.failure === null,
    isPickAgentHidden: !model.canPickAgent,
    isRefusalHidden: refusalText === null,
    isFlagged: model.misfit !== null,
    isFailed: model.failure !== null,
    isAsking: model.isAsking,
    isMenuOpen,
    refusalText: refusalText ?? '',
  };
}

export function shouldCloseMenuOnEscape(key: string, isMenuOpen: boolean): boolean {
  return key === 'Escape' && isMenuOpen;
}

export function parseChatCardAnswer(
  cardId: string | null,
  action: string | null,
  value: string | null,
): ChatCardAnswerDetail | null {
  if (cardId === null || action === null || value === null) return null;
  return { cardId, action, value };
}

export function resolvePaintedCards<Model extends AgentCardCoreModel>(
  models: readonly Model[],
  boundsOf: (boxId: string) => Rect | null,
): PaintedAgentCard<Model>[] {
  const painted: PaintedAgentCard<Model>[] = [];
  for (const model of models) {
    const boxId = model.boxIds.find((candidate) => boundsOf(candidate) !== null);
    const boxRect = boxId === undefined ? null : boundsOf(boxId);
    if (boxRect === null && !model.isMain) continue;
    const isCardShrunk = boxRect !== null && isShrunk(model);
    painted.push({
      sessionId: model.sessionId,
      model,
      boxRect,
      isCardShrunk,
      isWireHidden: boxRect === null || isCardShrunk,
    });
  }
  return painted;
}

function pruneRecordByKeys<Value>(
  record: Readonly<Record<string, Value>>,
  keptKeys: ReadonlySet<string>,
): Record<string, Value> {
  const next: Record<string, Value> = {};
  for (const [key, value] of Object.entries(record)) {
    if (keptKeys.has(key)) next[key] = value;
  }
  return next;
}

export function pruneAgentCardsState(
  state: AgentCardsCoreState,
  visibleSessionIds: ReadonlySet<string>,
): AgentCardsCoreState {
  return {
    openMenuSessionId: state.openMenuSessionId !== null && visibleSessionIds.has(state.openMenuSessionId)
      ? state.openMenuSessionId
      : null,
    refusalBySessionId: pruneRecordByKeys(state.refusalBySessionId, visibleSessionIds),
    placementBySessionId: pruneRecordByKeys(state.placementBySessionId, visibleSessionIds),
    cardSizeBySessionId: pruneRecordByKeys(state.cardSizeBySessionId, visibleSessionIds),
    mapBoundsRevision: state.mapBoundsRevision,
  };
}

export function toggleCardMenu(state: AgentCardsCoreState, sessionId: string): AgentCardsCoreState {
  return {
    ...state,
    openMenuSessionId: state.openMenuSessionId === sessionId ? null : sessionId,
  };
}

export function closeCardMenu(state: AgentCardsCoreState, sessionId?: string): AgentCardsCoreState {
  if (state.openMenuSessionId === null) return state;
  if (sessionId !== undefined && state.openMenuSessionId !== sessionId) return state;
  return { ...state, openMenuSessionId: null };
}

export function setCardRefusal(
  state: AgentCardsCoreState,
  sessionId: string,
  refusalText: string | null,
): AgentCardsCoreState {
  const nextRefusals = { ...state.refusalBySessionId };
  if (refusalText === null) {
    delete nextRefusals[sessionId];
    return { ...state, refusalBySessionId: nextRefusals };
  }
  nextRefusals[sessionId] = refusalText;
  return { ...state, refusalBySessionId: nextRefusals };
}

export function updateCardSize(
  state: AgentCardsCoreState,
  sessionId: string,
  size: CardSize,
): AgentCardsCoreState {
  const existing = state.cardSizeBySessionId[sessionId];
  if (existing && existing.width === size.width && existing.height === size.height) return state;
  return {
    ...state,
    cardSizeBySessionId: { ...state.cardSizeBySessionId, [sessionId]: size },
  };
}
