import { describeFailure } from './client-error-core.ts';
import { reportToServerLog } from './control-ws.ts';
import { onLayoutChange } from './form-factor.ts';
import { isFlyingAnimalsEnabled } from './ui-prefs.ts';

type NyanCatModule = typeof import('./nyan-cat.ts');

let isWatchingFlightAvailability = false;
let isBoardRevealed = false;
let isFlightRequested = false;
let loadedNyanCat: NyanCatModule | null = null;
let pendingNyanCatLoad: Promise<NyanCatModule | null> | null = null;

function loadNyanCat(): Promise<NyanCatModule | null> {
  pendingNyanCatLoad ??= import('./nyan-cat.ts').then(
    (nyanCat) => {
      loadedNyanCat = nyanCat;
      return nyanCat;
    },
    (error: unknown) => {
      pendingNyanCatLoad = null;
      reportToServerLog('flying-animals', `nyan cat failed to load: ${describeFailure(error)}`);
      return null;
    },
  );
  return pendingNyanCatLoad;
}

function syncFlight(nyanCat: NyanCatModule) {
  if (!isFlightRequested || nyanCat.currentFlightBlockReason(true)) {
    nyanCat.stopNyanCat();
    return;
  }
  nyanCat.startNyanCat();
}

export function revealFlyingAnimals() {
  isBoardRevealed = true;
  applyFlyingAnimals(isFlyingAnimalsEnabled());
}

export function applyFlyingAnimals(flyingAnimalsEnabled: boolean) {
  const root = document.documentElement;
  if (!isWatchingFlightAvailability) {
    isWatchingFlightAvailability = true;
    onLayoutChange(() => applyFlyingAnimals(isFlyingAnimalsEnabled()));
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => applyFlyingAnimals(isFlyingAnimalsEnabled()));
  }
  isFlightRequested = flyingAnimalsEnabled;
  if (!flyingAnimalsEnabled) {
    delete root.dataset.flyingAnimals;
    loadedNyanCat?.stopNyanCat();
    return;
  }
  root.dataset.flyingAnimals = 'true';
  if (loadedNyanCat) {
    syncFlight(loadedNyanCat);
    return;
  }
  if (!isBoardRevealed) return;
  void loadNyanCat().then((nyanCat) => {
    if (nyanCat) syncFlight(nyanCat);
  });
}
