import { describeFailure } from './client-error-core.ts';
import { reportToServerLog } from './control-ws.ts';
import type { MergeCelebrationText } from './github/my-prs-view-core.ts';
import type { OutlineIconButton } from './ui/button.ts';

type CelebrationPlayer = typeof import('./merge-celebration/celebration-player.ts');

const MAX_QUEUED_CELEBRATIONS = 20;

interface CelebrationTrayElements { tray: HTMLElement; toggle: OutlineIconButton<'attention'>; count: HTMLElement }

const queuedCelebrations: MergeCelebrationText[] = [];
let celebrationTray: CelebrationTrayElements | null = null;
let isPlayingQueuedCelebrations = false;
let playThroughPosition = 0;
let pendingPlayerLoad: Promise<CelebrationPlayer | null> | null = null;

function loadCelebrationPlayer(): Promise<CelebrationPlayer | null> {
  pendingPlayerLoad ??= import('./merge-celebration/celebration-player.ts').catch((error: unknown) => {
    pendingPlayerLoad = null;
    reportToServerLog('merge-celebration', `celebration player failed to load: ${describeFailure(error)}`);
    return null;
  });
  return pendingPlayerLoad;
}

function trayStateFor(hasQueuedCelebrations: boolean): 'playing' | 'queued' | 'empty' {
  if (isPlayingQueuedCelebrations) return 'playing';
  if (hasQueuedCelebrations) return 'queued';
  return 'empty';
}

function renderCelebrationTray(): void {
  if (!celebrationTray) return;
  const hasQueuedCelebrations = queuedCelebrations.length > 0;
  const trayState = trayStateFor(hasQueuedCelebrations);
  celebrationTray.tray.dataset.state = trayState;
  celebrationTray.count.textContent = hasQueuedCelebrations ? String(queuedCelebrations.length) : '';
  celebrationTray.toggle.element.disabled = trayState !== 'queued';
  celebrationTray.toggle.setState(trayState === 'queued' ? 'attention' : 'idle');
}

function playNextQueuedCelebration(): void {
  const nextCelebration = queuedCelebrations.shift();
  isPlayingQueuedCelebrations = nextCelebration !== undefined;
  renderCelebrationTray();
  if (!nextCelebration) return;
  const positionInPlayThrough = playThroughPosition;
  playThroughPosition += 1;
  void loadCelebrationPlayer().then((player) => {
    if (!player) {
      queuedCelebrations.unshift(nextCelebration);
      isPlayingQueuedCelebrations = false;
      renderCelebrationTray();
      return;
    }
    player.playCelebration(nextCelebration, positionInPlayThrough);
    window.setTimeout(playNextQueuedCelebration, player.CELEBRATION_DURATION_MS);
  });
}

export function mountCelebrationTray(tray: HTMLElement, toggle: OutlineIconButton<'attention'>, count: HTMLElement): void {
  celebrationTray = { tray, toggle, count };
  toggle.element.addEventListener('click', () => {
    playThroughPosition = 0;
    playNextQueuedCelebration();
  });
  renderCelebrationTray();
}

export function queueMergeCelebration(text: MergeCelebrationText): void {
  queuedCelebrations.push(text);
  if (queuedCelebrations.length > MAX_QUEUED_CELEBRATIONS) queuedCelebrations.shift();
  renderCelebrationTray();
}
