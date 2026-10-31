import test from 'node:test';
import assert from 'node:assert/strict';
import { readTracked } from '../helpers/tracked-files.ts';
import { renderFaviconSvg } from '../../public/favicon-core.ts';

test('the static favicon is the idle render, so the tab icon never changes shape on first update', () => {
  assert.equal(readTracked('public/favicon.svg').trim(), renderFaviconSvg('idle'));
});
