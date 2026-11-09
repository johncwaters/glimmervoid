import test from 'node:test';
import assert from 'node:assert/strict';
import { decideFaviconVariant, renderFaviconSvg } from '../public/favicon-core.ts';
import { BRAND_ACCENT, BRAND_INK } from '../shared/brand-mark.ts';

test('an attention favicon keeps the mark and recolors the whole of it', () => {
  const idle = renderFaviconSvg('idle');
  for (const [variant, color] of [['waiting', '#f59e0b'], ['failed', '#ef4444']] as const) {
    const attention = renderFaviconSvg(variant);
    assert.ok(attention.includes(`stroke="${color}"`), `${variant} colors the brackets ${color}`);
    assert.ok(attention.includes(`fill="${color}"`), `${variant} colors the light ${color}`);
    assert.equal(attention.replace(`stroke="${color}"`, `stroke="${BRAND_INK}"`).replace(`fill="${color}"`, `fill="${BRAND_ACCENT}"`), idle);
  }
});

test('waiting outranks failed for the favicon', () => {
  assert.equal(decideFaviconVariant({ waitingCount: 1, failedCount: 1, finishedCount: 0 }), 'waiting');
  assert.equal(decideFaviconVariant({ waitingCount: 0, failedCount: 2, finishedCount: 0 }), 'failed');
  assert.equal(decideFaviconVariant({ waitingCount: 0, failedCount: 0, finishedCount: 3 }), 'idle');
});
