import { isRealInputOwningKey } from '../dom-helpers.ts';
import { activateFocusOnNextAttention, centerSessionQuietly, focusAdjacentInRail, focusNextAttention, focusNthInRail, isFocusActive } from '../focus-view/focus-view.ts';
import { isPhoneLayout } from '../form-factor.ts';
import { jumpToNextReview } from '../github/review-queue-store.ts';
import { requestSessionRemoval, selectSession, setAddedSessionRevealer, spawnQuickSession } from '../session-actions.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { isModalOpen } from '../session-card/modal.ts';
import { currentNextAttentionKeyCode, SHORTCUT_PLATFORM } from '../shortcuts.ts';
import { resolveDashboardShortcut } from '../shortcuts-core.ts';
import type { ResolvedDashboardShortcut } from '../shortcuts-core.ts';
import { mergeSelectedSession, resolveSelectedSession, resyncSelectedSession } from '../sidebar/review-sidebar.ts';
import { getSelectedId } from '../sidebar/selection.ts';
import { toggleStreamerMode } from '../streamer-mode.ts';
import { getActiveView } from '../ui-state-core.ts';
import { jumpToNextAttentionOnBoard } from '../whiteboard/board-attention.ts';
import { activateView, focusViewTabIfFocused, stepViewTab } from './view-tabs.ts';

function focusedTerminalSessionId() {
  const focusedCard = document.activeElement?.closest<HTMLElement>('.session-card');
  return focusedCard?.dataset.id ?? null;
}

function revealSpawnedSession(id: string) {
  centerSessionQuietly(id);
  selectSession(id);
  requestAnimationFrame(() => requestAnimationFrame(() => sessionUIs.get(id)?.term?.focus()));
}

function addSessionLikeTheFocusedOne() {
  const sourceId = focusedTerminalSessionId() ?? getSelectedId();
  if (!sourceId) {
    document.getElementById('btn-add-session-header')?.click();
    return;
  }
  spawnQuickSession(sourceId);
}

function runDashboardShortcut({ action, step }: ResolvedDashboardShortcut) {
  switch (action) {
    case 'merge':
      mergeSelectedSession();
      return true;
    case 'close-session': {
      const selectedSessionId = getSelectedId();
      if (!selectedSessionId) return false;
      requestSessionRemoval(selectedSessionId);
      return true;
    }
    case 'resolve-or-resync':
      if (!resolveSelectedSession()) resyncSelectedSession();
      return true;
    case 'new-session':
      document.getElementById('btn-add-session-header')?.click();
      return true;
    case 'quick-session':
      addSessionLikeTheFocusedOne();
      return true;
    case 'next-attention':
      if (isPhoneLayout()) return false;
      if (isFocusActive()) {
        focusNextAttention();
        return true;
      }
      if (getActiveView() === 'prs' && jumpToNextReview()) return true;
      if (getActiveView() === 'boards' && jumpToNextAttentionOnBoard()) return true;
      activateFocusOnNextAttention(() => activateView('focus'));
      return true;
    case 'rail-step':
      if (!isFocusActive()) return false;
      focusAdjacentInRail(step);
      return true;
    case 'view-step':
      if (isPhoneLayout()) return false;
      focusViewTabIfFocused(stepViewTab(getActiveView(), step));
      return true;
    case 'session-nth':
      if (!isFocusActive()) return false;
      focusNthInRail(step);
      return true;
    case 'streamer-mode':
      toggleStreamerMode();
      return true;
  }
}

function wireDashboardShortcuts() {
  setAddedSessionRevealer(revealSpawnedSession);
  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (isRealInputOwningKey(e)) return;
    const isTerminalFocused = document.activeElement?.classList.contains('xterm-helper-textarea') ?? false;
    const shortcut = resolveDashboardShortcut(e, SHORTCUT_PLATFORM, { isTerminalFocused }, currentNextAttentionKeyCode());
    if (!shortcut) return;
    if (isModalOpen()) return;
    if (runDashboardShortcut(shortcut)) e.preventDefault();
  });
}

export { wireDashboardShortcuts };
