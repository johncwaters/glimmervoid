import { el, elWithMarkup, setStyleProperties } from '../dom-helpers.ts';
import type { MergeCelebrationScene } from './scenes.ts';
import { planStrikePinFlights, type StrikePinFlight, strikeLaneStyleProperties, strikePinStyleProperties } from './strike-core.ts';

const PIN_SILHOUETTE_SVG = '<svg viewBox="0 0 10 24" aria-hidden="true"><path class="merge-strike-pin-body" d="M5 0C7 0 7.6 2 7.2 4C6.9 5.6 6.3 6.6 6.4 8C6.6 10 9.6 12 9.6 16C9.6 19.5 8.4 22 7.6 24H2.4C1.6 22 .4 19.5 .4 16C.4 12 3.4 10 3.6 8C3.7 6.6 3.1 5.6 2.8 4C2.4 2 3 0 5 0Z"/><path class="merge-strike-pin-stripe" d="M3.1 5.2H6.9V6.2H3.1ZM3.4 7H6.6V8H3.4Z"/></svg>';

function createPin(flight: StrikePinFlight): HTMLElement {
  const pin = el('span', 'merge-strike-pin');
  pin.append(elWithMarkup('span', 'merge-strike-pin-arc', PIN_SILHOUETTE_SVG));
  setStyleProperties(pin, strikePinStyleProperties(flight));
  return pin;
}

function buildStrikeScene(): HTMLElement {
  const lane = el('div', 'merge-strike-lane');
  setStyleProperties(lane, strikeLaneStyleProperties());
  const rack = el('div', 'merge-strike-rack');
  rack.append(...planStrikePinFlights().map(createPin));
  const ballTrack = el('div', 'merge-strike-track');
  ballTrack.append(el('span', 'merge-strike-ball'));
  lane.append(rack, ballTrack);
  return lane;
}

export const strikeScene: MergeCelebrationScene = { title: 'STRIKE!', buildScene: buildStrikeScene };
