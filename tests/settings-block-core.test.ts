import test from 'node:test';
import assert from 'node:assert/strict';

import { INGEST_SPEC, mergeSettingsBlock, pickSettingsBlock, validateSettingsBlock } from '../server/core/settings-block-core.ts';
import { resolveIngestConfig } from '../server/core/ingest-core.ts';

test('an absent block is valid, so an untouched tab writes nothing', () => {
  assert.equal(validateSettingsBlock(null, INGEST_SPEC), null);
  assert.equal(validateSettingsBlock(undefined, INGEST_SPEC), null);
});

test('a non-object block is refused by name', () => {
  assert.equal(validateSettingsBlock('on', INGEST_SPEC), 'ingest must be an object');
  assert.equal(validateSettingsBlock({ sources: [] }, INGEST_SPEC), 'ingest.sources must be an object');
});

test('an unlisted key is refused by name at every depth', () => {
  assert.equal(validateSettingsBlock({ dir: '/tmp/x' }, INGEST_SPEC), 'ingest.dir is not settable from the dashboard');
  assert.equal(
    validateSettingsBlock({ sources: { fs: { roots: ['/'] } } }, INGEST_SPEC),
    'ingest.sources.fs.roots is not settable from the dashboard',
  );
});

test('a wrong type is refused rather than coerced, so a string cannot enable a lane', () => {
  assert.equal(validateSettingsBlock({ enabled: 1 }, INGEST_SPEC), 'ingest.enabled must be a boolean');
  assert.equal(
    validateSettingsBlock({ sources: { fs: { enabled: 'yes' } } }, INGEST_SPEC),
    'ingest.sources.fs.enabled must be a boolean',
  );
});

test('every ingest source the lane resolves has a settable gate and no settable bound', () => {
  const resolved = resolveIngestConfig({ enabled: true });
  for (const source of Object.keys(resolved.sources)) {
    assert.equal(validateSettingsBlock({ sources: { [source]: { enabled: true } } }, INGEST_SPEC), null);
    assert.equal(
      validateSettingsBlock({ sources: { [source]: { maxBytes: 1 } } }, INGEST_SPEC),
      `ingest.sources.${source}.maxBytes is not settable from the dashboard`,
    );
  }
});

test('a pick exposes only the allow-listed keys at every depth', () => {
  assert.equal(pickSettingsBlock(null, INGEST_SPEC), null);
  assert.deepEqual(
    pickSettingsBlock({ enabled: 1, secretPath: '/tmp/x', sources: { fs: { enabled: true, roots: ['/'] } } }, INGEST_SPEC),
    { enabled: true, sources: { fs: { enabled: true } } },
  );
});

test('a merge writes the allow-listed keys and keeps every other stored one', () => {
  const merged = mergeSettingsBlock(
    { enabled: false, futureKnob: 7, sources: { fs: { enabled: true, futureKnob: 9 } } },
    { enabled: true, sources: { fs: { enabled: false } } },
    INGEST_SPEC,
  );
  assert.deepEqual(merged, {
    enabled: true,
    futureKnob: 7,
    sources: { fs: { enabled: false, futureKnob: 9 } },
  });
});

test('a merge over no stored block builds one, and a truthy non-boolean cannot smuggle a value in', () => {
  assert.deepEqual(mergeSettingsBlock(undefined, { enabled: 'yes' }, INGEST_SPEC), { enabled: true });
});
