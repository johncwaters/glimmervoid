import { el } from './dom-helpers.ts';
import { hasIncludedAnimals } from './flying-animals-core.ts';
import { applyFlyingAnimals } from './flying-animals.ts';
import { currentFlightBlockReason, flyAnimalNow } from './nyan-cat.ts';
import { ANIMALS } from './nyan-animals.ts';
import { deriveNyanGeometry } from './nyan-geometry-core.ts';
import { getFlyingAnimalsOptions, isFlyingAnimalsEnabled, setFlyingAnimalsExcludedSprites } from './ui-prefs.ts';

export function renderFlyingAnimalsGallery() {
  const container = el('div');
  const status = el('p', 'flying-animals-status');
  status.id = 'flying-animals-gallery-status';
  status.setAttribute('role', 'status');
  const grid = el('div', 'flying-animals-gallery');
  grid.setAttribute('aria-label', 'Animal gallery');
  const flightButtons: HTMLButtonElement[] = [];
  const refreshAvailability = () => {
    const blockReason = currentFlightBlockReason();
    const isAnyAnimalIncluded = hasIncludedAnimals(getFlyingAnimalsOptions().flyingAnimalsExcludedSprites);
    status.textContent = [blockReason, isAnyAnimalIncluded ? '' : 'No animals are included, so automatic flights are paused.'].filter(Boolean).join(' ');
    for (const button of flightButtons) button.disabled = blockReason !== null;
  };
  const options = getFlyingAnimalsOptions();
  const geometry = deriveNyanGeometry({ viewportWidthPx: 1440, viewportHeightPx: 900, verticalProgress: 0 });
  for (const animal of ANIMALS) {
    const tile = el('article', 'flying-animal-tile');
    const preview = el('div', 'flying-animal-preview');
    preview.setAttribute('aria-hidden', 'true');
    preview.style.setProperty('--nyan-width', `${geometry.spriteWidthPx}px`);
    preview.style.setProperty('--nyan-height', `${geometry.spriteHeightPx}px`);
    const stage = el('div', 'flying-animal-preview-stage');
    stage.append(el('div', `nyan-trail ${animal.trail}`), el('div', `nyan-sprite ${animal.sprite}`));
    preview.append(stage);
    const include = el('label', 'flying-animal-include');
    const checkbox = el('input', 'settings-view-checkbox');
    checkbox.type = 'checkbox';
    checkbox.checked = !options.flyingAnimalsExcludedSprites.includes(animal.sprite);
    checkbox.setAttribute('aria-label', `Include ${animal.name}`);
    checkbox.addEventListener('change', () => {
      const exclusions = new Set(getFlyingAnimalsOptions().flyingAnimalsExcludedSprites);
      if (checkbox.checked) exclusions.delete(animal.sprite);
      if (!checkbox.checked) exclusions.add(animal.sprite);
      setFlyingAnimalsExcludedSprites([...exclusions]);
      applyFlyingAnimals(isFlyingAnimalsEnabled());
      refreshAvailability();
    });
    include.append(checkbox, document.createTextNode('Include'));
    const fly = el('button', 'btn-dialog btn-dialog-cancel', 'Fly now');
    fly.type = 'button';
    fly.setAttribute('aria-describedby', status.id);
    fly.addEventListener('click', () => flyAnimalNow(animal.sprite));
    flightButtons.push(fly);
    tile.append(preview, el('h2', 'flying-animal-name', animal.name), include, fly);
    grid.append(tile);
  }
  refreshAvailability();
  container.append(status, grid);
  return container;
}
