import './feature-hint.css';
import type { FeatureHint, HintFeature } from '#shared/contracts/feature-hints.ts';
import { HINT_VIEW_BY_FEATURE } from '#shared/contracts/feature-hints.ts';
import { REPO_SLUG } from '#shared/repo.ts';
import { sendControlMsg } from './control-ws.ts';
import { el } from './dom-helpers.ts';
import { openExternalUrl } from './external-link.ts';
import { featureHintMessage, featureSettingTarget } from './feature-hint-core.ts';
import { buildFlyingAnimalPreview, pickRandomIncludedAnimal } from './flying-animal-preview.ts';
import { button } from './ui/button.ts';
import { claimKey, claimNotification } from './notify-dedupe-core.ts';
import { ANIMALS } from './nyan-animals-core.ts';

interface FeatureHintHost {
  isFeatureEnabled: (feature: HintFeature) => boolean;
  openView: (view: string) => void;
  openSetting: (sectionId: string, settingId: string) => void;
}

let shownHintCard: HTMLElement | null = null;
let isStarHintWaiting = false;

function reportHintAction(feature: HintFeature, action: 'shown' | 'open' | 'dismiss') {
  sendControlMsg({ type: 'dashboard-telemetry', event: 'operator_action', properties: { surface: 'hints', action, feature } });
}

function claimCard(category: string, cardKey: string) {
  try {
    return claimNotification(localStorage, claimKey(category, cardKey), Date.now());
  } catch {
    return true;
  }
}

function openHintedFeature(feature: HintFeature, host: FeatureHintHost) {
  if (host.isFeatureEnabled(feature)) {
    host.openView(HINT_VIEW_BY_FEATURE[feature]);
    return;
  }
  const settingTarget = featureSettingTarget(feature);
  if (settingTarget) host.openSetting(settingTarget.sectionId, settingTarget.settingId);
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

export function showFeatureHint(hint: FeatureHint, host: FeatureHintHost) {
  if (isHintCardShown()) return;
  if (!claimCard('feature-hint', `${hint.feature}-${hint.raisedAt}`)) return;
  showHintCard({
    text: featureHintMessage(hint),
    ariaLabel: 'Feature tip',
    onOpen: () => {
      reportHintAction(hint.feature, 'open');
      openHintedFeature(hint.feature, host);
    },
    onDismiss: () => reportHintAction(hint.feature, 'dismiss'),
  });
  reportHintAction(hint.feature, 'shown');
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
