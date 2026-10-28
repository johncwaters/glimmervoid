import { deriveNyanGeometry, nyanFlightStyleProperties } from '../../../public/nyan-geometry-core.ts';
import { createElement } from './dom.ts';

export interface FlyingAnimalLook {
  sprite: string;
  trail: string;
}

export function launchAnimalFlight(sky: HTMLElement, { sprite, trail }: FlyingAnimalLook, topPx: number): void {
  const flight = createElement('div', 'nyan-flight');
  flight.append(createElement('div', `nyan-trail ${trail}`), createElement('div', `nyan-sprite ${sprite}`));
  const geometry = deriveNyanGeometry({ viewportWidthPx: sky.clientWidth, viewportHeightPx: sky.clientHeight, verticalProgress: 0 });
  const skyGeometry = { ...geometry, scale: 1, topPx };
  for (const [propertyName, value] of nyanFlightStyleProperties(skyGeometry, 1, window.devicePixelRatio)) flight.style.setProperty(propertyName, value);
  flight.style.top = 'var(--nyan-top)';
  flight.style.left = '0';
  flight.style.width = 'var(--nyan-width)';
  flight.style.height = 'var(--nyan-height)';
  flight.style.animationName = 'nyan-fly';
  flight.style.animationDuration = `${7 + Math.random() * 4}s`;
  flight.style.animationTimingFunction = 'linear';
  flight.addEventListener('animationend', (event) => {
    if (event.target === flight) flight.remove();
  });
  sky.append(flight);
}
