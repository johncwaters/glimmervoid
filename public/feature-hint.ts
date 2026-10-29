import './feature-hint.css';
import type { FeatureHint, HintFeature } from '#shared/contracts/feature-hints.ts';
import { HINT_VIEW_BY_FEATURE } from '#shared/contracts/feature-hints.ts';
import { sendControlMsg } from './control-ws.ts';
import { el } from './dom-helpers.ts';
import { featureHintMessage, featureSettingTarget } from './feature-hint-core.ts';
import { buildFlyingAnimalPreview, pickRandomIncludedAnimal } from './flying-animal-preview.ts';
import { claimKey, claimNotification } from './notify-dedupe-core.ts';
import { ANIMALS } from './nyan-animals-core.ts';

interface FeatureHintHost {
  isFeatureEnabled: (feature: HintFeature) => boolean;
  openView: (view: string) => void;
  openSetting: (sectionId: string, settingId: string) => void;
}

let shownHintCard: HTMLElement | null = null;

function reportHintAction(feature: HintFeature, action: 'shown' | 'open' | 'dismiss') {
  sendControlMsg({ type: 'dashboard-telemetry', event: 'operator_action', properties: { surface: 'hints', action, feature } });
}

function claimHint(hint: FeatureHint) {
  try {
    return claimNotification(localStorage, claimKey('feature-hint', `${hint.feature}-${hint.raisedAt}`), Date.now());
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

export function showFeatureHint(hint: FeatureHint, host: FeatureHintHost) {
  if (shownHintCard?.isConnected) return;
  if (!claimHint(hint)) return;

  const hintCard = el('aside', 'feature-hint');
  hintCard.setAttribute('aria-live', 'polite');
  hintCard.setAttribute('aria-label', 'Feature tip');
  const bubble = el('div', 'feature-hint-bubble');
  const showButton = el('button', 'btn-dialog btn-dialog-confirm', 'Show me');
  const dismissButton = el('button', 'btn-dialog btn-dialog-cancel', 'Nah');
  showButton.type = 'button';
  dismissButton.type = 'button';
  const actions = el('div', 'feature-hint-actions');
  actions.append(dismissButton, showButton);
  bubble.append(el('p', 'feature-hint-text', featureHintMessage(hint)), actions);
  const animal = pickRandomIncludedAnimal() ?? ANIMALS[0];
  hintCard.append(bubble, buildFlyingAnimalPreview(animal, 'feature-hint-animal'));

  function closeHint(action: 'open' | 'dismiss') {
    reportHintAction(hint.feature, action);
    hintCard.remove();
    shownHintCard = null;
  }
  showButton.addEventListener('click', () => {
    closeHint('open');
    openHintedFeature(hint.feature, host);
  });
  dismissButton.addEventListener('click', () => closeHint('dismiss'));

  document.body.append(hintCard);
  shownHintCard = hintCard;
  reportHintAction(hint.feature, 'shown');
}
