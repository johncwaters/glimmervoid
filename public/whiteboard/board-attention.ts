import { buildAttentionBanner, paintAttentionBanner } from '../attention-banner.ts';
import { countAttentionByKind, orderAttentionLine, orderRoster } from '../focus-view/attention-core.ts';
import { readSessionRows, requestSessionOpen, selectSession } from '../session-actions.ts';
import { markSessionSeen } from '../session-card/lifecycle.ts';
import { buildNextAttentionKeys } from '../shortcuts.ts';

interface BoardAttentionHooks {
  dockedSessionId: () => string | null;
  isBoardOpen: () => boolean;
  dockBesideOpenBoard: (sessionId: string) => boolean;
}

let hooks: BoardAttentionHooks | null = null;
let banner: HTMLElement | null = null;

function attentionRowsBesideDock() {
  const dockedSessionId = hooks?.dockedSessionId() ?? null;
  return orderRoster(readSessionRows()).filter((row) => row.id !== dockedSessionId);
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
  if (!hooks?.isBoardOpen()) return false;
  const [nextTile] = orderAttentionLine(attentionRowsBesideDock(), null);
  if (!nextTile) return true;
  if (!hooks.dockBesideOpenBoard(nextTile.id)) return false;
  requestSessionOpen(nextTile.id);
  markSessionSeen(nextTile.id);
  selectSession(nextTile.id);
  refreshBoardAttention();
  return true;
}
