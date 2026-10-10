import { el } from '../dom-helpers.ts';
import { headshotCrosshairStyleProperties } from './headshot-core.ts';
import type { MergeCelebrationScene } from './scenes.ts';

const TARGET_SVG = '<svg viewBox="0 0 26 40" aria-hidden="true"><path class="merge-headshot-target-body" d="M9 13H17L18 16Q25 18 25 24V40H1V24Q1 18 8 16Z"/><circle class="merge-headshot-target-head" cx="13" cy="7" r="6"/><circle class="merge-headshot-target-ring" cx="13" cy="7" r="3"/><circle class="merge-headshot-target-ring" cx="13" cy="27" r="6"/><circle class="merge-headshot-target-ring" cx="13" cy="27" r="2.5"/></svg>';
const CROSSHAIR_SVG = '<svg viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M11 0V5M11 17V22M0 11H5M17 11H22"/><circle class="merge-headshot-crosshair-dot" cx="11" cy="11" r="1"/></svg>';
const HITMARKER_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3L8 8M21 3L16 8M3 21L8 16M21 21L16 16"/></svg>';

function createTarget(): HTMLElement {
  const target = el('div', 'merge-headshot-target');
  target.innerHTML = TARGET_SVG;
  return target;
}

function createCrosshair(): HTMLElement {
  const sweep = el('div', 'merge-headshot-sweep');
  for (const [propertyName, propertyValue] of headshotCrosshairStyleProperties()) sweep.style.setProperty(propertyName, propertyValue);
  const aim = el('div', 'merge-headshot-aim');
  const crosshair = el('div', 'merge-headshot-crosshair');
  crosshair.innerHTML = CROSSHAIR_SVG;
  aim.append(crosshair);
  const hitmarker = el('div', 'merge-headshot-hitmarker');
  hitmarker.innerHTML = HITMARKER_SVG;
  const bob = el('div', 'merge-headshot-bob');
  bob.append(aim, hitmarker);
  sweep.append(bob);
  return sweep;
}

function buildHeadshotScene(): HTMLElement {
  const range = el('div', 'merge-headshot-range');
  const crosshairTrack = el('div', 'merge-headshot-track');
  crosshairTrack.append(createCrosshair());
  range.append(createTarget(), crosshairTrack);
  return range;
}

export const headshotScene: MergeCelebrationScene = { title: 'HEADSHOT!', buildScene: buildHeadshotScene };
