import type { BrandMarkSide } from '#shared/brand-mark.ts';
import { BRAND_INK } from '#shared/brand-mark.ts';

const INWARD: Readonly<Record<BrandMarkSide, readonly [number, number]>> = Object.freeze({
  top: [0, 1],
  right: [-1, 0],
  bottom: [0, -1],
  left: [1, 0],
});

const SETTLE_MS = 160;
const SPIN_MS = 950;
const BOLTS_AT_MS = 900;
const LIGHT_AT_MS = 980;
const HOLD_AFTER_LIGHT_MS = 450;
const BURST_MS = 720;
const FADE_LEAD_MS = 260;
const SNAP = 'cubic-bezier(0.22, 1, 0.36, 1)';
const CLICK = 'cubic-bezier(0.2, 0.8, 0.3, 1)';

const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

function isBrandMarkSide(value: string | undefined): value is BrandMarkSide {
  return value !== undefined && Object.hasOwn(INWARD, value);
}

function bracketsOf(mark: SVGElement): Array<{ bracket: SVGElement; dx: number; dy: number }> {
  return [...mark.querySelectorAll('.loading-mark-bracket')].flatMap((bracket) => {
    const side = bracket instanceof SVGElement ? bracket.dataset.side : undefined;
    if (!(bracket instanceof SVGElement) || !isBrandMarkSide(side)) return [];
    const [dx, dy] = INWARD[side];
    return [{ bracket, dx, dy }];
  });
}

function settleScan(brackets: ReturnType<typeof bracketsOf>) {
  for (const { bracket } of brackets) {
    const style = getComputedStyle(bracket);
    const from = { transform: style.transform === 'none' ? 'none' : style.transform, stroke: style.stroke };
    bracket.animate([from, { transform: 'none', stroke: BRAND_INK }], { duration: SETTLE_MS, easing: 'ease-out' });
  }
}

function spinDial(dial: Element) {
  dial.animate([
    { transform: 'rotate(0deg)', easing: 'cubic-bezier(0.5, 0, 0.15, 1)' },
    { transform: 'rotate(360deg)', offset: 0.86, easing: CLICK },
    { transform: 'rotate(354deg)', offset: 0.93, easing: CLICK },
    { transform: 'rotate(360deg)' },
  ], { duration: SPIN_MS });
}

function throwBolts(brackets: ReturnType<typeof bracketsOf>) {
  for (const { bracket, dx, dy } of brackets) {
    const engaged = `translate(${dx * 7}px, ${dy * 7}px)`;
    bracket.animate([
      { transform: 'none' },
      { transform: engaged, offset: 0.22 },
      { transform: engaged, offset: 0.4 },
      { transform: 'none' },
    ], { duration: 520, delay: BOLTS_AT_MS, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)' });
  }
}

function lightUp(light: Element, halo: Element) {
  light.animate([{ transform: 'scale(0)' }, { transform: 'scale(1.35)', offset: 0.4 }, { transform: 'scale(1)' }], { duration: 480, delay: LIGHT_AT_MS, easing: SNAP, fill: 'forwards' });
  halo.animate([{ transform: 'scale(1)', opacity: 0.8 }, { transform: 'scale(3.4)', opacity: 0 }], { duration: 700, delay: LIGHT_AT_MS + 20, easing: 'ease-out' });
}

function burst(brackets: ReturnType<typeof bracketsOf>, light: Element, halo: Element) {
  for (const { bracket, dx, dy } of brackets) {
    bracket.animate([
      { transform: 'none', opacity: 1 },
      { transform: `translate(${dx * 4}px, ${dy * 4}px)`, opacity: 1, offset: 0.18 },
      { transform: `translate(${-dx * 46}px, ${-dy * 46}px)`, opacity: 0 },
    ], { duration: BURST_MS, easing: 'cubic-bezier(0.6, 0, 0.2, 1)', fill: 'forwards' });
  }
  light.animate([
    { transform: 'scale(1)', opacity: 1 },
    { transform: 'scale(0.7)', opacity: 1, offset: 0.18 },
    { transform: 'scale(5)', opacity: 0.5, offset: 0.45 },
    { transform: 'scale(9)', opacity: 0 },
  ], { duration: BURST_MS, easing: 'cubic-bezier(0.5, 0, 0.2, 1)', fill: 'forwards' });
  halo.animate([{ transform: 'scale(1)', opacity: 0 }, { transform: 'scale(1)', opacity: 1, offset: 0.2 }, { transform: 'scale(12)', opacity: 0 }], { duration: 900, easing: 'ease-out' });
}

export async function playLoadingUnlock(screen: HTMLElement): Promise<void> {
  const mark = screen.querySelector('.loading-mark');
  const dial = screen.querySelector('.loading-mark-dial');
  const light = screen.querySelector('.loading-mark-light');
  const halo = screen.querySelector('.loading-mark-halo');
  if (reducedMotion?.matches || document.hidden || !(mark instanceof SVGElement) || !dial || !light || !halo) return;
  const brackets = bracketsOf(mark);
  settleScan(brackets);
  screen.dataset.unlock = 'spin';
  await wait(SETTLE_MS);
  spinDial(dial);
  throwBolts(brackets);
  lightUp(light, halo);
  await wait(LIGHT_AT_MS);
  screen.dataset.unlock = 'lit';
  await wait(HOLD_AFTER_LIGHT_MS);
  screen.dataset.unlock = 'burst';
  burst(brackets, light, halo);
  await wait(FADE_LEAD_MS);
}
