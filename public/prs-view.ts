import { mountMyPrsView } from './my-prs-panel.ts';
import { resyncPrQueueLayouts } from './pr-queue-columns.ts';
import { createPrScopeTabs } from './pr-scope-tabs.ts';
import { acknowledgeTeamReviewAttention, mountTeamReviewView } from './team-review-panel.ts';
import { getPrsMode, setPrsMode } from './ui-prefs.ts';

export function acknowledgePrsViewAttention(): void {
  if (getPrsMode() === 'team') acknowledgeTeamReviewAttention();
}

export function mountPrsView(viewPrsElement: HTMLElement): void {
  const onSelectMode = (mode: 'team' | 'mine', isKeyboard: boolean): void => {
    applyPrsMode(mode);
    acknowledgePrsViewAttention();
    if (!isKeyboard) return;
    const selectedScopeTab = (mode === 'team' ? teamScopeTabs : mineScopeTabs).querySelector<HTMLButtonElement>('[aria-selected="true"]');
    if (selectedScopeTab && selectedScopeTab.getClientRects().length > 0) {
      selectedScopeTab.focus();
      return;
    }
    (mode === 'team' ? teamPrsRoot : minePrsRoot).querySelector<HTMLButtonElement>('.pr-queue-toggle')?.focus();
  };
  const teamScopeTabs = createPrScopeTabs('team', onSelectMode);
  const mineScopeTabs = createPrScopeTabs('mine', onSelectMode);
  const teamPrsRoot = document.createElement('div');
  teamPrsRoot.className = 'pr-mode-root';
  const minePrsRoot = document.createElement('div');
  minePrsRoot.className = 'pr-mode-root';
  viewPrsElement.append(teamPrsRoot, minePrsRoot);
  mountTeamReviewView(teamPrsRoot, teamScopeTabs);
  mountMyPrsView(minePrsRoot, mineScopeTabs);

  function applyPrsMode(mode: 'team' | 'mine'): void {
    resyncPrQueueLayouts();
    teamPrsRoot.hidden = mode !== 'team';
    minePrsRoot.hidden = mode !== 'mine';
    setPrsMode(mode);
  }

  applyPrsMode(getPrsMode());
}
