import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decideFaviconVariant, renderFaviconSvg } from '../public/favicon-core.ts';

const STATIC_FAVICON = path.join(import.meta.dirname, '..', 'public', 'favicon.svg');

test('the static favicon is the idle render, so the tab icon never changes shape on first update', () => {
  assert.equal(fs.readFileSync(STATIC_FAVICON, 'utf8').trim(), renderFaviconSvg('idle'));
});

test('an attention favicon keeps the mark and only recolors its light', () => {
  const idle = renderFaviconSvg('idle');
  for (const [variant, light] of [['waiting', '#f59e0b'], ['failed', '#ef4444']] as const) {
    const attention = renderFaviconSvg(variant);
    assert.ok(attention.includes(`fill="${light}"`), `${variant} lights the mark ${light}`);
    assert.equal(attention.replace(light, '#c084fc'), idle);
  }
});

test('waiting outranks failed for the favicon', () => {
  assert.equal(decideFaviconVariant({ waitingCount: 1, failedCount: 1, finishedCount: 0 }), 'waiting');
  assert.equal(decideFaviconVariant({ waitingCount: 0, failedCount: 2, finishedCount: 0 }), 'failed');
  assert.equal(decideFaviconVariant({ waitingCount: 0, failedCount: 0, finishedCount: 3 }), 'idle');
});
