import { el } from '../dom-helpers.ts';
import type { MergeCelebrationScene } from './scenes.ts';

const TARGET_SVG = '<svg viewBox="0 0 36 36" aria-hidden="true"><circle class="merge-bullseye-ring-light" cx="18" cy="18" r="17"/><circle class="merge-bullseye-ring-red" cx="18" cy="18" r="13"/><circle class="merge-bullseye-ring-light" cx="18" cy="18" r="9"/><circle class="merge-bullseye-ring-red" cx="18" cy="18" r="5"/></svg>';
const DART_SVG = '<svg viewBox="0 0 26 8" aria-hidden="true"><path class="merge-bullseye-dart-flight" d="M0 0L7 3V5L0 8L2 4Z"/><rect class="merge-bullseye-dart-shaft" x="6" y="3.3" width="8" height="1.4"/><rect class="merge-bullseye-dart-barrel" x="13" y="2.5" width="7" height="3" rx="1"/><path class="merge-bullseye-dart-tip" d="M20 3L26 4L20 5Z"/></svg>';

function createTarget(): HTMLElement {
  const target = el('div', 'merge-bullseye-target');
  target.innerHTML = TARGET_SVG;
  target.append(el('span', 'merge-bullseye-ripple'));
  return target;
}

function createDart(): HTMLElement {
  const drift = el('div', 'merge-bullseye-dart-drift');
  const arc = el('div', 'merge-bullseye-dart-arc');
  const aim = el('div', 'merge-bullseye-dart-aim');
  const dart = el('div', 'merge-bullseye-dart');
  dart.innerHTML = DART_SVG;
  aim.append(dart);
  arc.append(aim);
  drift.append(arc);
  return drift;
}

function buildBullseyeScene(): HTMLElement {
  const range = el('div', 'merge-bullseye-range');
  const dartTrack = el('div', 'merge-bullseye-track');
  dartTrack.append(createDart());
  range.append(createTarget(), dartTrack);
  return range;
}

export const bullseyeScene: MergeCelebrationScene = { title: 'BULLSEYE!', buildScene: buildBullseyeScene };
