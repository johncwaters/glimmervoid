import './feature-hint.css';
import { REPO_SLUG } from '#shared/repo.ts';
import { sendControlMsg } from './control-ws.ts';
import { el } from './dom-helpers.ts';
import { openExternalUrl } from './external-link.ts';
import { buildFlyingAnimalPreview, pickRandomIncludedAnimal } from './flying-animal-preview.ts';
import { button } from './ui/button.ts';
import { claimKey, claimNotification } from './notify-dedupe-core.ts';
import { ANIMALS } from './nyan-animals-core.ts';
import { clock } from '#shared/clock.ts';

let shownHintCard: HTMLElement | null = null;
let isStarHintWaiting = false;

function claimCard(category: string, cardKey: string) {
  try {
    return claimNotification(localStorage, claimKey(category, cardKey), clock.nowMs());
  } catch {
    return true;
  }
}

interface HintCardActions {
  text: string;
  ariaLabel: string;
  openLabel?: string;
  onOpen: () => void;
  onDismiss: () => void;
}

export function isHintCardShown() {
  return shownHintCard?.isConnected === true;
}

export function showHintCard({ text, ariaLabel, openLabel = 'Show me', onOpen, onDismiss }: HintCardActions) {
  const hintCard = el('aside', 'feature-hint');
  hintCard.setAttribute('aria-live', 'polite');
  hintCard.setAttribute('aria-label', ariaLabel);
  const bubble = el('div', 'feature-hint-bubble');
  const showButton = button({ variant: 'primary', label: openLabel });
  const dismissButton = button({ variant: 'secondary', label: 'Dismiss' });
  const actions = el('div', 'feature-hint-actions');
  actions.append(dismissButton, showButton);
  bubble.append(el('p', 'feature-hint-text', text), actions);
  const animal = pickRandomIncludedAnimal() ?? ANIMALS[0];
  hintCard.append(bubble, buildFlyingAnimalPreview(animal, 'feature-hint-animal'));

  function closeHint() {
    hintCard.remove();
    shownHintCard = null;
    if (!isStarHintWaiting) return;
    isStarHintWaiting = false;
    showStarHint();
  }
  showButton.addEventListener('click', () => {
    closeHint();
    onOpen();
  });
  dismissButton.addEventListener('click', () => {
    closeHint();
    onDismiss();
  });

  document.body.append(hintCard);
  shownHintCard = hintCard;
}

function reportStarHintAction(action: 'shown' | 'open' | 'dismiss') {
  sendControlMsg({ type: 'dashboard-telemetry', event: 'operator_action', properties: { surface: 'star', action } });
}

export function showStarHint() {
  if (isHintCardShown()) {
    isStarHintWaiting = true;
    return;
  }
  if (!claimCard('star-hint', 'card')) return;
  showHintCard({
    text: 'Enjoying Glimmervoid? A star on GitHub helps other people find it.',
    ariaLabel: 'Star Glimmervoid on GitHub',
    openLabel: 'Star on GitHub',
    onOpen: () => {
      reportStarHintAction('open');
      openExternalUrl(`https://github.com/${REPO_SLUG}`);
    },
    onDismiss: () => reportStarHintAction('dismiss'),
  });
  reportStarHintAction('shown');
}
