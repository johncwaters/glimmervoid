import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INGEST_SPEC, SECRET_PRESENCE_SUFFIX, mergeSettingsBlock, pickSettingsBlock, settingsBlockSpecFor, validateSettingsBlock,
} from '../server/core/settings-block-core.ts';
import { resolveIngestConfig } from '../server/ingest/core/ingest-core.ts';
import { SETTINGS_REGISTRY } from '../shared/settings/registry.ts';
import { settingsBlockSpec, settingsOf } from '../shared/settings/registry-core.ts';

const POSTHOG_SPEC = settingsBlockSpecFor('posthog');
const TELEGRAM_SPEC = settingsBlockSpecFor('telegram');
const POST_TURN_SPEC = settingsBlockSpecFor('postTurnChecks');

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

test('a pick exposes only the allow-listed keys at every depth, and a toggle only when it holds a real boolean', () => {
  assert.equal(pickSettingsBlock(null, INGEST_SPEC), null);
  assert.deepEqual(
    pickSettingsBlock({ enabled: 1, secretPath: '/tmp/x', sources: { fs: { enabled: true, roots: ['/'] } } }, INGEST_SPEC),
    { sources: { fs: { enabled: true } } },
  );
  assert.deepEqual(
    pickSettingsBlock({ enabled: true, autoFix: 'false', dispatch: { enabled: true, maxPerHour: 6 } }, settingsBlockSpecFor('visions')),
    { enabled: true, dispatch: { enabled: true, maxPerHour: 6 } },
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

test('the ingest spec is the registry build, not a hand-kept list, and a toggle-only block carries no value map', () => {
  assert.deepEqual(INGEST_SPEC, settingsBlockSpec('ingest'));
  assert.equal('values' in INGEST_SPEC, false);
  assert.equal('passthrough' in INGEST_SPEC, false);
  assert.equal(Object.isFrozen(INGEST_SPEC.blocks.sources), true);
  assert.equal(settingsBlockSpecFor('ingest'), INGEST_SPEC, 'the registry build is memoized');
});

test('the registry build widens a block to every leaf kind its entries name', () => {
  assert.deepEqual(POSTHOG_SPEC.booleans, ['enabled', 'trafficSpikeEnabled', 'autoFix', 'recurrenceDedupe']);
  assert.deepEqual(POSTHOG_SPEC.blocks, {});
  assert.deepEqual(POSTHOG_SPEC.values?.apiKey, { control: 'password', nullable: false });
  assert.deepEqual(POSTHOG_SPEC.values?.host, { control: 'text', nullable: false });
  assert.deepEqual(POSTHOG_SPEC.values?.intervalMinutes, { control: 'number', nullable: false });
  assert.deepEqual(POSTHOG_SPEC.values?.projects, { control: 'list', nullable: false, valueKind: 'posthog-projects' });
  assert.deepEqual(POSTHOG_SPEC.values?.projectMap, { control: 'json', nullable: false });
  assert.deepEqual(settingsBlockSpecFor('visions').blocks.dispatch.values?.model, { control: 'text', nullable: false });
  assert.deepEqual(settingsBlockSpecFor('usage').blocks.budget.values?.dailyUsd, { control: 'number', nullable: true });
});

test('every registry config leaf lands in exactly one place of its block spec', () => {
  const leaves = [...settingsOf(SETTINGS_REGISTRY.sections), ...SETTINGS_REGISTRY.fileOnly]
    .filter((setting) => setting.control !== 'readonly' && !setting.path.startsWith('pref:') && setting.path.includes('.'));
  assert.ok(leaves.length > 80);
  for (const setting of leaves) {
    const [topLevel, ...parts] = setting.path.split('.');
    let node = settingsBlockSpecFor(topLevel);
    for (const part of parts.slice(0, -1)) node = node.blocks[part];
    const leaf = parts.at(-1) as string;
    const asToggle = node.booleans.includes(leaf);
    const asValue = Object.hasOwn(node.values ?? {}, leaf);
    assert.equal(asToggle !== asValue, true, setting.path);
    assert.equal(asToggle, setting.control === 'toggle', setting.path);
  }
});

test('a block the registry lists as one structured value passes through whole, beside its own leaves', () => {
  assert.equal(POST_TURN_SPEC.passthrough, true);
  assert.deepEqual(POST_TURN_SPEC.values?.mode, { control: 'select', nullable: false });
  const stored = { enabled: true, mode: 'report', rules: { trailingWs: true, slop: false } };
  const picked = pickSettingsBlock(stored, POST_TURN_SPEC);
  assert.deepEqual(picked, stored);
  assert.notEqual(picked?.rules, stored.rules, 'the pick is a copy');
  assert.equal(validateSettingsBlock({ rules: { bom: false } }, POST_TURN_SPEC), null);
  assert.equal(validateSettingsBlock({ mode: 7 }, POST_TURN_SPEC), 'postTurnChecks.mode must be a string');
  assert.deepEqual(
    mergeSettingsBlock(stored, { mode: 'fix', rules: { bom: false } }, POST_TURN_SPEC),
    { enabled: true, mode: 'fix', rules: { bom: false } },
  );
});

test('a pick never carries a password leaf, only its presence flag', () => {
  assert.equal(SECRET_PRESENCE_SUFFIX, 'Configured');
  assert.deepEqual(
    pickSettingsBlock({ apiKey: 'phx_secret', host: 'https://ph.test', enabled: true, projects: [1, 2], futureKey: 'x' }, POSTHOG_SPEC),
    { enabled: true, host: 'https://ph.test', projects: [1, 2], apiKeyConfigured: true },
  );
  assert.deepEqual(pickSettingsBlock({ chatId: '123' }, TELEGRAM_SPEC), { chatId: '123', botTokenConfigured: false });
  assert.deepEqual(pickSettingsBlock({ botToken: '' }, TELEGRAM_SPEC), { botTokenConfigured: false });
  assert.deepEqual(pickSettingsBlock({ botToken: 'tok' }, TELEGRAM_SPEC), { botTokenConfigured: true });
  assert.equal(JSON.stringify(pickSettingsBlock({ botToken: 'tok-secret', chatId: '1' }, TELEGRAM_SPEC)).includes('tok-secret'), false);
});

test('a pick carries a stored null for a nullable leaf and copies lists and objects', () => {
  assert.deepEqual(pickSettingsBlock({ projectMap: { 7: '/repo' } }, POSTHOG_SPEC), { projectMap: { 7: '/repo' }, apiKeyConfigured: false });
});

test('validation checks each leaf kind and honours nullable', () => {
  assert.equal(validateSettingsBlock({ host: 'https://ph.test', apiKey: 'k', intervalMinutes: 5, projectMap: {} }, POSTHOG_SPEC), null);
  assert.equal(validateSettingsBlock({ host: 7 }, POSTHOG_SPEC), 'posthog.host must be a string');
  assert.equal(validateSettingsBlock({ apiKey: 7 }, POSTHOG_SPEC), 'posthog.apiKey must be a string');
  assert.equal(validateSettingsBlock({ intervalMinutes: '5' }, POSTHOG_SPEC), 'posthog.intervalMinutes must be a number');
  assert.equal(validateSettingsBlock({ intervalMinutes: Number.NaN }, POSTHOG_SPEC), 'posthog.intervalMinutes must be a number');
  assert.equal(validateSettingsBlock({ projectMap: 'x' }, POSTHOG_SPEC), 'posthog.projectMap must be an object');
  assert.equal(validateSettingsBlock({ host: null }, POSTHOG_SPEC), 'posthog.host must not be null');
  assert.equal(validateSettingsBlock({ projects: [1, 2] }, POSTHOG_SPEC), null, 'a leaf with a value kind is shaped by its contract');
});

test('a merge writes every leaf kind, clears a nullable leaf or a nested block with null and ignores null elsewhere', () => {
  const stored = { enabled: true, apiKey: 'old', host: 'https://old.test', futureKnob: 1 };
  const merged = mergeSettingsBlock(stored, { apiKey: 'new', host: null, intervalMinutes: 3, projects: [4], enabled: null }, POSTHOG_SPEC);
  assert.deepEqual(merged, { enabled: true, apiKey: 'new', host: 'https://old.test', futureKnob: 1, intervalMinutes: 3, projects: [4] });
  assert.deepEqual(
    mergeSettingsBlock({ refiner: { enabled: false, model: 'opus' } }, { refiner: null }, settingsBlockSpecFor('taskTitle')),
    { refiner: null },
  );
});

test('a spec built from a custom registry is not memoized against the shipped one', () => {
  const registry = {
    sections: [{
      id: 'x', level: 'lanes' as const, title: 'X', description: '', settings: [
        { id: 'a', path: 'posthog.custom', title: 'A', description: '', keywords: [], control: 'number' as const, scope: 'machine' as const, access: 'editable' as const, takesEffect: 'now' as const },
      ],
    }],
    fileOnly: [],
  };
  assert.deepEqual(settingsBlockSpecFor('posthog', registry), { name: 'posthog', booleans: [], blocks: {}, values: { custom: { control: 'number', nullable: false } } });
  assert.equal(settingsBlockSpecFor('posthog'), POSTHOG_SPEC);
});
