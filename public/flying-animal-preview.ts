import { el } from './dom-helpers.ts';
import { pickIncludedAnimalIndex } from './flying-animals-core.ts';
import { ANIMALS } from './nyan-animals.ts';
import { deriveNyanGeometry } from './nyan-geometry-core.ts';
import { getFlyingAnimalsOptions } from './ui-prefs.ts';

type FlyingAnimal = (typeof ANIMALS)[number];

const previewGeometry = deriveNyanGeometry({ viewportWidthPx: 1440, viewportHeightPx: 900, verticalProgress: 0 });

export function buildFlyingAnimalPreview(animal: FlyingAnimal, extraClassName = '') {
  const preview = el('div', `flying-animal-preview ${extraClassName}`.trim());
  preview.setAttribute('aria-hidden', 'true');
  preview.style.setProperty('--nyan-width', `${previewGeometry.spriteWidthPx}px`);
  preview.style.setProperty('--nyan-height', `${previewGeometry.spriteHeightPx}px`);
  const stage = el('div', 'flying-animal-preview-stage');
  stage.append(el('div', `nyan-trail ${animal.trail}`), el('div', `nyan-sprite ${animal.sprite}`));
  preview.append(stage);
  return preview;
}

export function pickRandomIncludedAnimal(): FlyingAnimal | null {
  const animalIndex = pickIncludedAnimalIndex(getFlyingAnimalsOptions().flyingAnimalsExcludedSprites);
  if (animalIndex === null) return null;
  return ANIMALS[animalIndex] ?? null;
}
