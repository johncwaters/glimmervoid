import { ANIMALS, pickAnimalIndex } from './nyan-animals.ts';
import { deriveNyanGeometry } from './nyan-geometry-core.ts';

const MIN_DURATION_S = 6.9;
const MAX_DURATION_S = 11.5;
const MIN_GAP_MS = 4000;
const MAX_GAP_MS = 20000;

function pickFlight(rng: () => number = Math.random) {
  const durationS = MIN_DURATION_S + rng() * (MAX_DURATION_S - MIN_DURATION_S);
  const gapMs = MIN_GAP_MS + rng() * (MAX_GAP_MS - MIN_GAP_MS);
  const firstDelayS = rng() * durationS;
  const verticalProgress = rng();
  return { durationS, gapMs, firstDelayS, verticalProgress };
}

let _el: HTMLDivElement | null = null;
let _sprite: HTMLDivElement | null = null;
let _trail: HTMLDivElement | null = null;
let _timeoutId: number | null = null;
let _lastAnimal = -1;
let _verticalProgress: number | null = null;

function updateFlightGeometry() {
  if (!_el || _verticalProgress === null) return;
  const geometry = deriveNyanGeometry({
    viewportWidthPx: document.documentElement.clientWidth,
    viewportHeightPx: document.documentElement.clientHeight,
    verticalProgress: _verticalProgress,
  });
  _el.style.setProperty('--nyan-top', `${geometry.topPx}px`);
  _el.style.setProperty('--nyan-scale', String(geometry.scale));
  _el.style.setProperty('--nyan-width', `${geometry.spriteWidthPx}px`);
  _el.style.setProperty('--nyan-height', `${geometry.spriteHeightPx}px`);
  _el.style.setProperty('--nyan-start-x', `${geometry.startXpx}px`);
  _el.style.setProperty('--nyan-end-x', `${geometry.endXpx}px`);
}

function launchFlight(isFirst: boolean) {
  if (!_el || !_sprite || !_trail) return;
  const { durationS, gapMs, firstDelayS, verticalProgress } = pickFlight();
  _verticalProgress = verticalProgress;
  updateFlightGeometry();
  const animalIndex = pickAnimalIndex(Math.random, _lastAnimal);
  const animal = ANIMALS[animalIndex];
  _sprite.className = `nyan-sprite ${animal.sprite}`;
  _trail.className = `nyan-trail ${animal.trail}`;
  _lastAnimal = animalIndex;
  _el.style.animation = `nyan-fly ${durationS}s linear`;
  if (isFirst) {
    _el.style.animationDelay = `-${firstDelayS}s`;
  }
  _el.addEventListener(
    'animationend',
    () => {
      if (!_el) return;
      _el.style.animation = 'none';
      _timeoutId = setTimeout(() => launchFlight(false), gapMs);
    },
    { once: true }
  );
}

export function startNyanCat() {
  if (_el) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const flight = document.createElement('div');
  flight.className = 'nyan-flight';
  const trail = document.createElement('div');
  trail.className = 'nyan-trail';
  const sprite = document.createElement('div');
  sprite.className = 'nyan-sprite';
  flight.appendChild(trail);
  flight.appendChild(sprite);
  document.body.appendChild(flight);
  _el = flight;
  _sprite = sprite;
  _trail = trail;

  window.addEventListener('resize', updateFlightGeometry);
  window.addEventListener('orientationchange', updateFlightGeometry);
  launchFlight(true);
}

export function stopNyanCat() {
  if (_timeoutId !== null) {
    clearTimeout(_timeoutId);
    _timeoutId = null;
  }
  window.removeEventListener('resize', updateFlightGeometry);
  window.removeEventListener('orientationchange', updateFlightGeometry);
  if (_el) {
    _el.remove();
    _el = null;
    _sprite = null;
    _trail = null;
  }
  _lastAnimal = -1;
  _verticalProgress = null;
}
