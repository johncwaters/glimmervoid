import { onLayoutChange } from './form-factor.ts';
import { isFlyingAnimalsEnabled } from './ui-prefs.ts';
import { currentFlightBlockReason, startNyanCat, stopNyanCat } from './nyan-cat.ts';

let isWatchingFlightAvailability = false;

export function applyFlyingAnimals(flyingAnimalsEnabled: boolean) {
  const root = document.documentElement;
  if (!isWatchingFlightAvailability) {
    isWatchingFlightAvailability = true;
    onLayoutChange(() => applyFlyingAnimals(isFlyingAnimalsEnabled()));
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => applyFlyingAnimals(isFlyingAnimalsEnabled()));
  }
  if (flyingAnimalsEnabled) {
    root.dataset.flyingAnimals = 'true';
    if (currentFlightBlockReason(flyingAnimalsEnabled)) {
      stopNyanCat();
      return;
    }
    startNyanCat();
    return;
  }
  delete root.dataset.flyingAnimals;
  stopNyanCat();
}
