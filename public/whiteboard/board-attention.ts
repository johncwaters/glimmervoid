import { buildAttentionBanner, paintAttentionBanner } from '../attention-banner.ts';
import { isPhoneLayout } from '../form-factor.ts';
import { countAttentionByKind, orderAttentionLine, orderRoster } from '../focus-view/attention-core.ts';
import { readSessionRows, requestSessionOpen, selectSession } from '../session-actions.ts';
import { markSessionSeen } from '../session-card/lifecycle.ts';
import { buildNextAttentionKeys } from '../shortcuts.ts';
import { openNewestBoardDocked } from './board-chips.ts';

interface BoardAttentionHooks {
  dockedSessionId: () => string | null;
  isBoardOpen: () => boolean;
}

let hooks: BoardAttentionHooks | null = null;
let openSessionInFocus: (sessionId: string) => void = () => {};
let banner: HTMLElement | null = null;

function attentionRowsBesideDock() {
  const dockedSessionId = hooks?.dockedSessionId() ?? null;
  return orderRoster(readSessionRows()).filter((row) => row.id !== dockedSessionId);
}

export function setBoardAttentionFocusOpener(open: (sessionId: string) => void): void {
  openSessionInFocus = open;
}

export function buildBoardAttentionBanner(boardHooks: BoardAttentionHooks): HTMLElement {
  hooks = boardHooks;
  banner = buildAttentionBanner({ onJump: () => void jumpToNextAttentionOnBoard(), rowFor: () => null }, buildNextAttentionKeys());
  banner.classList.add('wb-attention');
  refreshBoardAttention();
  return banner;
}

export function refreshBoardAttention(): void {
  if (!banner) return;
  const rows = attentionRowsBesideDock();
  paintAttentionBanner(banner, countAttentionByKind(rows), orderAttentionLine(rows, null));
}

export function jumpToNextAttentionOnBoard(): boolean {
  if (isPhoneLayout() || !hooks?.isBoardOpen()) return false;
  const [nextTile] = orderAttentionLine(attentionRowsBesideDock(), null);
  if (!nextTile) return true;
  if (!requestSessionOpen(nextTile.id)) return true;
  if (!openNewestBoardDocked(nextTile.id)) {
    openSessionInFocus(nextTile.id);
    return true;
  }
  markSessionSeen(nextTile.id);
  selectSession(nextTile.id);
  refreshBoardAttention();
  return true;
}
