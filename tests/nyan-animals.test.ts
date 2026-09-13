import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ANIMALS, pickAnimalIndex } from '../public/nyan-animals.ts';
import { deriveNyanGeometry } from '../public/nyan-geometry-core.ts';

test('ANIMALS: 18 entries, all sprite/trail classes unique', () => {
  assert.equal(ANIMALS.length, 18);
  const sprites = ANIMALS.map((animal) => animal.sprite);
  const trails = ANIMALS.map((animal) => animal.trail);
  assert.equal(new Set(sprites).size, 18);
  assert.equal(new Set(trails).size, 18);
});

test('pickAnimalIndex: never returns prevIndex across a sweep of rng values', () => {
  const animalCount = ANIMALS.length;
  for (let prevIndex = 0; prevIndex < animalCount; prevIndex++) {
    const seen = new Set<number>();
    for (let step = 0; step < 1000; step++) {
      const picked = pickAnimalIndex(() => step / 1000, prevIndex);
      assert.notEqual(picked, prevIndex);
      seen.add(picked);
    }
    assert.equal(seen.size, animalCount - 1, `prevIndex ${prevIndex} should reach all other indices`);
  }
});

test('pickAnimalIndex: an absent or out-of-range prevIndex allows every index', () => {
  const animalCount = ANIMALS.length;
  for (const prevIndex of [-1, 999, -5, animalCount]) {
    const seen = new Set<number>();
    for (let step = 0; step < 1000; step++) seen.add(pickAnimalIndex(() => step / 1000, prevIndex));
    assert.equal(seen.size, animalCount, `prevIndex ${prevIndex} should allow all indices`);
  }
});

test('every roster sprite/trail class has a matching flying-animals CSS rule', () => {
  const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'style.css'), 'utf8');
  assert.equal(css.includes(':root[data-theme="unicorn"] .nyan-'), false);
  const baseFlightZIndex = Number(readDeclaration(css, ':root[data-flying-animals="true"] .nyan-flight', 'z-index'));
  const phoneFlightSelector = 'html[data-layout="phone"][data-flying-animals="true"] .nyan-flight';
  const phoneFlightZIndex = Number(readDeclaration(css, phoneFlightSelector, 'z-index'));
  assert.ok(phoneFlightZIndex > Number(readDeclaration(css, '.phone-shell', 'z-index')));
  assert.ok(baseFlightZIndex < Number(readDeclaration(css, '.header', 'z-index')));
  for (const animal of ANIMALS) {
    assert.ok(css.includes(`.nyan-sprite.${animal.sprite}`), `missing sprite rule for ${animal.sprite}`);
    assert.ok(css.includes(`.nyan-trail.${animal.trail}`), `missing trail rule for ${animal.trail}`);
  }
});

test('deriveNyanGeometry: preserves desktop scale and travel proportions', () => {
  const geometry = deriveNyanGeometry({ viewportWidthPx: 1440, viewportHeightPx: 900, verticalProgress: 0.5 });
  assert.equal(geometry.scale, 1);
  assert.equal(geometry.startXpx, -0.45 * 1440);
  assert.equal(geometry.endXpx, 1.45 * 1440);
});

test('deriveNyanGeometry: scales narrow sprites and preserves vertical clearance', () => {
  const geometry = deriveNyanGeometry({ viewportWidthPx: 360, viewportHeightPx: 300, verticalProgress: 1 });
  assert.equal(geometry.scale, 0.68);
  assert.ok(geometry.topPx >= 64);
});

test('deriveNyanGeometry: keeps vertical placement relative to the viewport across resize', () => {
  const verticalProgress = 1;
  const wideGeometry = deriveNyanGeometry({ viewportWidthPx: 1440, viewportHeightPx: 900, verticalProgress });
  const narrowGeometry = deriveNyanGeometry({ viewportWidthPx: 360, viewportHeightPx: 640, verticalProgress });
  assert.equal(wideGeometry.topPx / 900, narrowGeometry.topPx / 640);
});

function readDeclaration(css: string, selectorFragment: string, property: string) {
  for (const [, selector, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selector.includes(selectorFragment)) continue;
    const declaration = declarations.match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`));
    if (!declaration) continue;
    return declaration[1].trim();
  }
  throw new Error(`no ${property} declared for ${selectorFragment}`);
}

function readNyanSections(css: string) {
  const sections = [...css.matchAll(/@keyframes nyan-[\w-]+\s*\{[\s\S]*?\n\}/g)].map((match) => match[0]);
  for (const [block, selector] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selector.includes('nyan')) sections.push(block);
  }
  return sections.join('\n');
}

test('the flight box comes from the geometry core, not stylesheet literals', () => {
  const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'style.css'), 'utf8');
  const nyanFrames = css.match(/@keyframes nyan-frames\s*\{[\s\S]*?\n\}/);
  assert.ok(nyanFrames, 'no nyan-frames keyframes block');
  assert.match(readDeclaration(css, '.nyan-flight', 'width'), /var\(--nyan-width\)/);
  assert.match(readDeclaration(css, '.nyan-flight', 'height'), /var\(--nyan-height\)/);
  const backgroundSize = readDeclaration(css, '.nyan-sprite', 'background-size');
  assert.match(backgroundSize, /var\(--nyan-width\)/);
  assert.match(backgroundSize, /var\(--nyan-height\)/);
  assert.match(readDeclaration(nyanFrames[0], 'to', 'background-position-x'), /var\(--nyan-width\)/);
  const nyanSections = readNyanSections(css);
  for (const literal of ['61.2px', '37.8px', '367.2px']) {
    assert.equal(nyanSections.includes(literal), false, `stylesheet literal ${literal} should come from the geometry core`);
  }
});
