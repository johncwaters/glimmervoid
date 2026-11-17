import { el } from './dom-helpers.ts';
import { hasIncludedAnimals } from './flying-animals-core.ts';
import { applyFlyingAnimals } from './flying-animals.ts';
import { currentFlightBlockReason, flyAnimalNow } from './nyan-cat.ts';
import { buildFlyingAnimalPreview } from './flying-animal-preview.ts';
import { ANIMALS } from './nyan-animals-core.ts';
import { getFlyingAnimalsOptions, isFlyingAnimalsEnabled, setFlyingAnimalsExcludedSprites } from './ui-prefs.ts';
import { button } from './ui/button.ts';
import { checkbox } from './ui/checkbox.ts';

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
    for (const flightButton of flightButtons) flightButton.disabled = blockReason !== null;
  };
  const options = getFlyingAnimalsOptions();
  for (const animal of ANIMALS) {
    const tile = el('article', 'flying-animal-tile');
    const preview = buildFlyingAnimalPreview(animal);
    const include = checkbox({
      label: 'Include',
      checked: !options.flyingAnimalsExcludedSprites.includes(animal.sprite),
      accessibleName: `Include ${animal.name}`,
      onChange: (isIncluded) => {
        const exclusions = new Set(getFlyingAnimalsOptions().flyingAnimalsExcludedSprites);
        if (isIncluded) exclusions.delete(animal.sprite);
        if (!isIncluded) exclusions.add(animal.sprite);
        setFlyingAnimalsExcludedSprites([...exclusions]);
        applyFlyingAnimals(isFlyingAnimalsEnabled());
        refreshAvailability();
      },
    }).element;
    const fly = button({ variant: 'secondary', label: 'Fly now' });
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
