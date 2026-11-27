import './feature-hint.css';
import { REPO_SLUG } from '#shared/repo.ts';
import { sendControlMsg } from './control-ws.ts';
import { el } from './dom-helpers.ts';
import { openExternalUrl } from './external-link.ts';
import { isPhoneLayout, onLayoutChange } from './form-factor.ts';
import { buildLockMark, playLockMark } from './loading-unlock.ts';
import { localStorageBackend } from './local-store.ts';
import { button } from './ui/button.ts';
import { claimKey, claimNotification } from './notify-dedupe-core.ts';
import { clock } from '#shared/clock.ts';

let shownHintCard: HTMLElement | null = null;
let isStarHintWaiting = false;

function hintCardHost(): HTMLElement {
  if (!isPhoneLayout()) return document.body;
  return document.querySelector<HTMLElement>('.phone-notice-slot') ?? document.body;
}

function mountHintCard(hintCard: HTMLElement) {
  const host = hintCardHost();
  if (hintCard.parentElement === host) return;
  host.append(hintCard);
}

onLayoutChange(() => {
  if (!shownHintCard?.isConnected) return;
  mountHintCard(shownHintCard);
});

function claimCard(category: string, cardKey: string) {
  try {
    return claimNotification(localStorageBackend, claimKey(category, cardKey), clock.nowMs());
  } catch {
    return true;
  }
}

interface HintCardFact {
  value: string;
  label: string;
}

interface HintCardContent {
  eyebrow: string;
  title: string;
  detail?: string;
  facts?: readonly HintCardFact[];
  ariaLabel: string;
  openLabel?: string;
  onOpen: () => void;
  onDismiss: () => void;
}

export function isHintCardShown() {
  return shownHintCard?.isConnected === true;
}

function buildFacts(facts: readonly HintCardFact[]) {
  const factList = el('dl', 'feature-hint-facts');
  for (const fact of facts) {
    const factRow = el('div', 'feature-hint-fact');
    factRow.append(el('dt', 'feature-hint-fact-label', fact.label), el('dd', 'feature-hint-fact-value', fact.value));
    factList.append(factRow);
  }
  return factList;
}

export function showHintCard({ eyebrow, title, detail, facts = [], ariaLabel, openLabel = 'Show me', onOpen, onDismiss }: HintCardContent) {
  const hintCard = el('aside', 'feature-hint');
  hintCard.setAttribute('aria-live', 'polite');
  hintCard.setAttribute('aria-label', ariaLabel);
  const head = el('div', 'feature-hint-head');
  head.append(buildLockMark('feature-hint-mark'), el('span', 'feature-hint-eyebrow', eyebrow));
  hintCard.append(head);
  if (facts.length > 0) hintCard.append(buildFacts(facts));
  hintCard.append(el('p', 'feature-hint-title', title));
  if (detail) hintCard.append(el('p', 'feature-hint-detail', detail));
  const showButton = button({ variant: 'primary', label: openLabel });
  const dismissButton = button({ variant: 'secondary', label: 'Dismiss' });
  const actions = el('div', 'feature-hint-actions');
  actions.append(dismissButton, showButton);
  hintCard.append(actions);

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

  mountHintCard(hintCard);
  shownHintCard = hintCard;
  void playLockMark(hintCard);
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
    eyebrow: 'Glimmervoid',
    title: 'Enjoying Glimmervoid?',
    detail: 'A star on GitHub helps other people find it.',
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
