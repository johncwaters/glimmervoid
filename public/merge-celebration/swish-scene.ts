import { el } from '../dom-helpers.ts';
import type { MergeCelebrationScene } from './scenes.ts';
import { swishCourtStyleProperties } from './swish-core.ts';

const HOOP_BACK_SVG = '<svg viewBox="0 0 40 48" aria-hidden="true"><rect class="merge-swish-pole" x="36" y="28" width="2" height="20"/><rect class="merge-swish-backboard" x="35" y="2" width="3" height="26" rx="1"/><path class="merge-swish-rim" d="M31 18H35M7 18A12 2.5 0 0 1 31 18"/></svg>';
const HOOP_FRONT_SVG = '<svg viewBox="0 0 40 48" aria-hidden="true"><g class="merge-swish-net"><path d="M8 18L12 32M13.5 18L15.5 32M19 18V32M24.5 18L22.5 32M30 18L26 32M9.5 23Q19 25 28.5 23M11 28Q19 29.5 27 28"/></g><path class="merge-swish-rim" d="M7 18A12 2.5 0 0 0 31 18"/></svg>';

function createHoopLayer(className: string, svgMarkup: string): HTMLElement {
  const layer = el('div', className);
  layer.innerHTML = svgMarkup;
  return layer;
}

function createBall(): HTMLElement {
  const drift = el('div', 'merge-swish-ball-drift');
  const arc = el('div', 'merge-swish-ball-arc');
  arc.append(el('span', 'merge-swish-ball'));
  drift.append(arc);
  return drift;
}

function buildSwishScene(): HTMLElement {
  const court = el('div', 'merge-swish-court');
  for (const [propertyName, value] of swishCourtStyleProperties()) court.style.setProperty(propertyName, value);
  const ballTrack = el('div', 'merge-swish-track');
  ballTrack.append(createBall());
  court.append(createHoopLayer('merge-swish-hoop-back', HOOP_BACK_SVG), ballTrack, createHoopLayer('merge-swish-hoop-front', HOOP_FRONT_SVG));
  return court;
}

export const swishScene: MergeCelebrationScene = { title: 'SWISH!', buildScene: buildSwishScene };
