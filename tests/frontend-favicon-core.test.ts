import test from 'node:test';
import assert from 'node:assert/strict';

import { decideFaviconVariant } from '../public/favicon-core.ts';

test('decideFaviconVariant: waiting takes priority over complete', () => {
  assert.equal(decideFaviconVariant([{ state: 'COMPLETE' }, { state: 'WAITING' }]), 'waiting');
  assert.equal(decideFaviconVariant([{ state: 'WAITING' }, { state: 'COMPLETE' }]), 'waiting');
  assert.equal(decideFaviconVariant([{ state: 'COMPLETE' }, { state: 'RUNNING' }]), 'complete');
});

test('decideFaviconVariant: an empty list is idle', () => {
  assert.equal(decideFaviconVariant([]), 'idle');
});
