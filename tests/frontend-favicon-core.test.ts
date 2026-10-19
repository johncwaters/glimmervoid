import test from 'node:test';
import assert from 'node:assert/strict';

import { decideFaviconVariant } from '../public/favicon-core.ts';

test('decideFaviconVariant: only sessions that need action now mark the tab', () => {
  assert.equal(decideFaviconVariant([{ state: 'COMPLETE' }, { state: 'FAILED' }, { state: 'WAITING' }]), 'waiting');
  assert.equal(decideFaviconVariant([{ state: 'COMPLETE' }, { state: 'FAILED' }]), 'failed');
  assert.equal(decideFaviconVariant([{ state: 'COMPLETE' }, { state: 'RUNNING' }]), 'idle');
});

test('decideFaviconVariant: an empty list is idle', () => {
  assert.equal(decideFaviconVariant([]), 'idle');
});
