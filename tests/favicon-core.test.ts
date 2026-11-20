import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideFaviconVariant } from '../public/favicon-core.ts';

test('waiting outranks failed for the favicon', () => {
  assert.equal(decideFaviconVariant({ waitingCount: 1, failedCount: 1, finishedCount: 0 }), 'waiting');
  assert.equal(decideFaviconVariant({ waitingCount: 0, failedCount: 2, finishedCount: 0 }), 'failed');
  assert.equal(decideFaviconVariant({ waitingCount: 0, failedCount: 0, finishedCount: 3 }), 'idle');
});
