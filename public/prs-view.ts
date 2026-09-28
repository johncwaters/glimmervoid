import { mountMyPrsView } from './my-prs-panel.ts';
import { resyncPrQueueLayouts } from './pr-queue-columns.ts';
import { acknowledgeTeamReviewAttention, mountTeamReviewView } from './team-review-panel.ts';
import { getPrsMode, setPrsMode } from './ui-prefs.ts';

export function acknowledgePrsViewAttention(): void {
  if (getPrsMode() === 'team') acknowledgeTeamReviewAttention();
}

export function mountPrsView(viewPrsElement: HTMLElement): void {
  const prsModeSwitch = document.createElement('div');
  prsModeSwitch.className = 'pr-mode-switch';
  prsModeSwitch.setAttribute('role', 'group');
  prsModeSwitch.setAttribute('aria-label', 'Reviews view');
  const teamModeButton = document.createElement('button');
  teamModeButton.type = 'button';
  teamModeButton.textContent = 'Team';
  const mineModeButton = document.createElement('button');
  mineModeButton.type = 'button';
  mineModeButton.textContent = 'Mine';
  prsModeSwitch.append(teamModeButton, mineModeButton);
  const teamPrsRoot = document.createElement('div');
  teamPrsRoot.className = 'pr-mode-root';
  const minePrsRoot = document.createElement('div');
  minePrsRoot.className = 'pr-mode-root';
  viewPrsElement.append(prsModeSwitch, teamPrsRoot, minePrsRoot);
  mountTeamReviewView(teamPrsRoot);
  mountMyPrsView(minePrsRoot);

  function applyPrsMode(mode: 'team' | 'mine'): void {
    resyncPrQueueLayouts();
    teamModeButton.setAttribute('aria-pressed', String(mode === 'team'));
    mineModeButton.setAttribute('aria-pressed', String(mode === 'mine'));
    teamPrsRoot.hidden = mode !== 'team';
    minePrsRoot.hidden = mode !== 'mine';
    setPrsMode(mode);
  }

  function selectPrsMode(mode: 'team' | 'mine'): void {
    applyPrsMode(mode);
    acknowledgePrsViewAttention();
  }

  teamModeButton.addEventListener('click', () => selectPrsMode('team'));
  mineModeButton.addEventListener('click', () => selectPrsMode('mine'));
  applyPrsMode(getPrsMode());
}
