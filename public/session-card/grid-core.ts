import {
  DATA_ATTACH_HISTORY_PARAM,
  DATA_ATTACH_OUTPUT_PARAM,
  DATA_ATTACH_PAUSED_OUTPUT,
  DEEP_HISTORY_SCROLLBACK_LINES,
  parseDataServerFrame,
  VIEWER_MAX_COLS,
  VIEWER_MAX_ROWS,
  VIEWER_MIN_COLS,
  VIEWER_MIN_ROWS,
} from '#shared/contracts/data-messages.ts';

export interface TerminalGrid {
  cols: number;
  rows: number;
}

interface GridDecisionInput {
  authoritative: TerminalGrid | null;
  applied: TerminalGrid | null;
  proposal: TerminalGrid | null;
  isActiveViewer: boolean;
  isDataWsOpen: boolean;
  lastClaim: TerminalGrid | null;
}

interface GridActions {
  resizeTo: TerminalGrid | null;
  owedClaim: TerminalGrid | null;
  keepsPendingSettle: boolean;
  sendUnview: boolean;
  isFollowing: boolean;
}

interface ViewerEngagementInput {
  isDocumentVisible: boolean;
  isDocumentFocused: boolean;
  hasFocusInsideCard: boolean;
  hasWindowBlurredSinceFocus: boolean;
  isPhoneLayout: boolean;
}

interface CardTerminalVisibilityInput {
  isBorrowedCard: boolean;
  isTerminalFaceShown: boolean;
}

interface DeepHistoryRequestInput {
  viewportTopLine: number;
  scrollbackLineCount: number;
  isDeepHistoryLoadedOrPending: boolean;
}

interface GridEngagementEdgeInput {
  authoritative: TerminalGrid | null;
  isActiveViewer: boolean;
  isDocumentEngaged: boolean;
  isDataWsOpen: boolean;
  lastClaim: TerminalGrid | null;
}

type GridEngagementEdgeAction = 'none' | 'resync' | 'rebid';

export interface DataFrameState {
  hasSeenSize: boolean;
  lastSeq: number;
}

type DataFrameDecision =
  | { kind: 'attach-size'; cols: number; rows: number; seq: number }
  | { kind: 'size'; cols: number; rows: number; seq: number }
  | { kind: 'bytes'; data: string }
  | { kind: 'beat' }
  | { kind: 'stale' }
  | { kind: 'ignored' };

function isSameGrid(one: TerminalGrid | null, other: TerminalGrid | null): boolean {
  if (!one || !other) return false;
  return one.cols === other.cols && one.rows === other.rows;
}

function isUsableGrid(grid: TerminalGrid | null): grid is TerminalGrid {
  if (!grid) return false;
  if (!Number.isInteger(grid.cols) || !Number.isInteger(grid.rows)) return false;
  return grid.cols > 0 && grid.rows > 0;
}

function clampGridToContract(grid: TerminalGrid): TerminalGrid {
  return {
    cols: Math.min(Math.max(grid.cols, VIEWER_MIN_COLS), VIEWER_MAX_COLS),
    rows: Math.min(Math.max(grid.rows, VIEWER_MIN_ROWS), VIEWER_MAX_ROWS),
  };
}

export function isFollowingGrid({
  authoritative,
  isActiveViewer,
  lastClaim,
}: Pick<GridDecisionInput, 'authoritative' | 'isActiveViewer' | 'lastClaim'>): boolean {
  return !(isActiveViewer && isSameGrid(authoritative, lastClaim));
}

export function isViewerEngaged({
  isDocumentVisible,
  isDocumentFocused,
  hasFocusInsideCard,
  hasWindowBlurredSinceFocus,
  isPhoneLayout,
}: ViewerEngagementInput): boolean {
  if (!isDocumentVisible) return false;
  if (isPhoneLayout) return true;
  if (isDocumentFocused) return true;
  return hasFocusInsideCard && !hasWindowBlurredSinceFocus;
}

export function isCardTerminalHidden({
  isBorrowedCard,
  isTerminalFaceShown,
}: CardTerminalVisibilityInput): boolean {
  return !isBorrowedCard || !isTerminalFaceShown;
}

export function shouldRequestDeepHistory({
  viewportTopLine,
  scrollbackLineCount,
  isDeepHistoryLoadedOrPending,
}: DeepHistoryRequestInput): boolean {
  const isLocalHistoryBelowServerCap = scrollbackLineCount > 0 && scrollbackLineCount < DEEP_HISTORY_SCROLLBACK_LINES;
  return viewportTopLine === 0 && isLocalHistoryBelowServerCap && !isDeepHistoryLoadedOrPending;
}

export function dataAttachPath(sessionId: string, isDeepHistory: boolean, isOutputPaused: boolean): string {
  const query = new URLSearchParams();
  if (isDeepHistory) query.set(DATA_ATTACH_HISTORY_PARAM, 'deep');
  if (isOutputPaused) query.set(DATA_ATTACH_OUTPUT_PARAM, DATA_ATTACH_PAUSED_OUTPUT);
  const sessionPath = `/terminals/${encodeURIComponent(sessionId)}`;
  const queryText = query.toString();
  return queryText ? `${sessionPath}?${queryText}` : sessionPath;
}

export function decideGridEngagementEdge({
  authoritative,
  isActiveViewer,
  isDocumentEngaged,
  isDataWsOpen,
  lastClaim,
}: GridEngagementEdgeInput): GridEngagementEdgeAction {
  if (!isActiveViewer || !isDocumentEngaged || !isDataWsOpen) return 'none';
  if (isFollowingGrid({ authoritative, isActiveViewer, lastClaim })) return 'rebid';
  return 'resync';
}

export function retainGridClaimForReconnect({ isActiveViewer, lastClaim, owedClaim }: {
  isActiveViewer: boolean;
  lastClaim: TerminalGrid | null;
  owedClaim: TerminalGrid | null;
}): TerminalGrid | null {
  if (!isActiveViewer) return null;
  return owedClaim ?? lastClaim;
}

export function decideGridActions({
  authoritative,
  applied,
  proposal,
  isActiveViewer,
  isDataWsOpen,
  lastClaim,
}: GridDecisionInput): GridActions {
  const needsResize = !!authoritative && !isSameGrid(authoritative, applied);
  const claimable = isUsableGrid(proposal) ? clampGridToContract(proposal) : null;
  const isClaimOwed = isActiveViewer && !!claimable && !isSameGrid(claimable, lastClaim);
  return {
    resizeTo: needsResize ? authoritative : null,
    owedClaim: isClaimOwed ? claimable : null,
    keepsPendingSettle: isActiveViewer && !claimable,
    sendUnview: !isActiveViewer && isDataWsOpen && !!lastClaim,
    isFollowing: isFollowingGrid({ authoritative, isActiveViewer, lastClaim }),
  };
}

function textOfBinaryFrame(frame: unknown): string | null {
  if (frame instanceof ArrayBuffer) return new TextDecoder().decode(frame);
  if (ArrayBuffer.isView(frame)) return new TextDecoder().decode(frame);
  return null;
}

function serverFrameOrNull(frame: unknown) {
  const text = textOfBinaryFrame(frame);
  if (text === null) return null;
  return parseDataServerFrame(text);
}

export function readDataFrame(frame: unknown, state: DataFrameState): DataFrameDecision {
  if (typeof frame === 'string') return { kind: 'bytes', data: frame };
  const serverFrame = serverFrameOrNull(frame);
  if (!serverFrame) return { kind: 'ignored' };
  if (serverFrame.type === 'output-beat') return { kind: 'beat' };
  if (!state.hasSeenSize) return { kind: 'attach-size', cols: serverFrame.cols, rows: serverFrame.rows, seq: serverFrame.seq };
  if (serverFrame.seq <= state.lastSeq) return { kind: 'stale' };
  return { kind: 'size', cols: serverFrame.cols, rows: serverFrame.rows, seq: serverFrame.seq };
}
