import { setStyleProperties } from './dom-helpers.ts';
import { isPhoneLayout } from './form-factor.ts';
import { ANIMALS } from './nyan-animals-core.ts';
import { deriveNyanGeometry, nyanFlightStyleProperties } from './nyan-geometry-core.ts';
import { deriveFlyingAnimalLaunch, flyingAnimalsFlightBlockReason } from './flying-animals-core.ts';
import { getFlyingAnimalsOptions, isFlyingAnimalsEnabled } from './ui-prefs.ts';

let flightElement: HTMLDivElement | null = null;
let spriteElement: HTMLDivElement | null = null;
let trailElement: HTMLDivElement | null = null;
let trailHoldElement: HTMLDivElement | null = null;
let timeoutId: number | null = null;
let lastAnimalIndex = -1;
let verticalProgress: number | null = null;
let flightPath = { isRightToLeft: false, arcProgress: 0 };
let flightScale = 1;

function updateFlightGeometry() {
  if (!flightElement || verticalProgress === null) return;
  const geometry = deriveNyanGeometry({
    viewportWidthPx: document.documentElement.clientWidth,
    viewportHeightPx: document.documentElement.clientHeight,
    verticalProgress,
    ...flightPath,
  });
  setStyleProperties(flightElement, nyanFlightStyleProperties(geometry, flightScale, window.devicePixelRatio));
}

function clearScheduledFlight() {
  if (timeoutId === null) return;
  clearTimeout(timeoutId);
  timeoutId = null;
}

export function currentFlightBlockReason(isEnabled = isFlyingAnimalsEnabled()) {
  return flyingAnimalsFlightBlockReason({
    isEnabled,
    hasReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    isPhone: isPhoneLayout(),
    options: getFlyingAnimalsOptions(),
  });
}

function parkFlight(flight: HTMLDivElement) {
  flight.onanimationend = null;
  flight.style.animation = 'none';
  if (trailHoldElement) trailHoldElement.style.animation = 'none';
  flight.hidden = true;
}

function launchFlight(isFirst: boolean, requestedSprite?: string) {
  if (!flightElement || !spriteElement || !trailElement || !trailHoldElement) return;
  if (currentFlightBlockReason()) return;
  const options = getFlyingAnimalsOptions();
  clearScheduledFlight();
  const launch = deriveFlyingAnimalLaunch(options, lastAnimalIndex, Math.random, requestedSprite);
  parkFlight(flightElement);
  if (!launch) {
    timeoutId = setTimeout(() => launchFlight(false), 1000);
    return;
  }
  verticalProgress = launch.verticalProgress;
  flightPath = { isRightToLeft: launch.isRightToLeft, arcProgress: launch.arcProgress };
  flightScale = options.flyingAnimalsScale;
  updateFlightGeometry();
  const animal = ANIMALS[launch.animalIndex];
  spriteElement.className = `nyan-sprite ${animal.sprite}`;
  trailElement.className = `nyan-trail ${animal.trail}`;
  lastAnimalIndex = launch.animalIndex;
  flightElement.hidden = false;
  void flightElement.offsetWidth;
  flightElement.style.animation = `nyan-fly ${launch.durationSeconds}s linear`;
  trailHoldElement.style.animation = `nyan-trail-hold ${launch.durationSeconds}s linear`;
  if (isFirst) {
    flightElement.style.animationDelay = `-${launch.firstDelaySeconds}s`;
    trailHoldElement.style.animationDelay = `-${launch.firstDelaySeconds}s`;
  }
  flightElement.onanimationend = (event) => {
    if (!flightElement || event.target !== flightElement) return;
    parkFlight(flightElement);
    timeoutId = setTimeout(() => launchFlight(false), launch.gapMs);
  };
}

export function startNyanCat() {
  if (flightElement) return;
  if (currentFlightBlockReason()) return;
  flightElement = document.createElement('div');
  flightElement.className = 'nyan-flight';
  flightElement.setAttribute('aria-hidden', 'true');
  const trailWindowElement = document.createElement('div');
  trailWindowElement.className = 'nyan-trail-window';
  trailHoldElement = document.createElement('div');
  trailHoldElement.className = 'nyan-trail-hold';
  trailElement = document.createElement('div');
  trailHoldElement.append(trailElement);
  trailWindowElement.append(trailHoldElement);
  spriteElement = document.createElement('div');
  flightElement.append(trailWindowElement, spriteElement);
  document.body.appendChild(flightElement);
  window.addEventListener('resize', updateFlightGeometry);
  window.addEventListener('orientationchange', updateFlightGeometry);
  launchFlight(true);
}

export function flyAnimalNow(sprite: string) {
  startNyanCat();
  launchFlight(false, sprite);
}

export function stopNyanCat() {
  clearScheduledFlight();
  window.removeEventListener('resize', updateFlightGeometry);
  window.removeEventListener('orientationchange', updateFlightGeometry);
  flightElement?.remove();
  flightElement = null;
  spriteElement = null;
  trailElement = null;
  trailHoldElement = null;
  lastAnimalIndex = -1;
  verticalProgress = null;
}
