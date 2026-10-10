import test from 'node:test';
import assert from 'node:assert/strict';

import { SETTINGS_MAP } from '../public/settings-map.ts';
import { collectDirtyBlocks, hydrateFromSettings } from '../public/settings-view-core.ts';
import { DEFAULT_CONFIG } from '../server/config-store.ts';
import { connectControl, controlDeps, createControlServer, testConfigStore } from './helpers/control-harness.ts';

interface SettingsFrame {
  type: string;
  message?: string;
  settings?: Record<string, unknown>;
}

const serverSavedToggles = SETTINGS_MAP
  .filter((section) => section.level !== 'browser')
  .flatMap((section) => section.settings.map((setting) => ({ section, setting })))
  .filter(({ setting }) => setting.control === 'toggle' && !setting.path.startsWith('pref:'));

function dashboardSession() {
  const config = structuredClone({ ...DEFAULT_CONFIG, projects: [] });
  const store = testConfigStore(config);
  const server = createControlServer(controlDeps(config, {
    configStore: store,
    applySettingsReload: (fresh) => { store.applySettings(fresh); },
  }));
  const connection = connectControl<SettingsFrame>(server);
  function request(message: Record<string, unknown>, replyType: string): SettingsFrame {
    connection.sent.length = 0;
    connection.send(message);
    const reply = connection.sent.find((frame) => frame.type === replyType || frame.type === 'settings-error');
    assert.ok(reply, `no ${replyType} reply`);
    assert.notEqual(reply.type, 'settings-error', String(reply.message));
    return reply;
  }
  return { request };
}

test('every server-saved toggle on the settings page survives a dashboard save', () => {
  assert.ok(serverSavedToggles.some(({ setting }) => setting.path === 'changeMap.narrator.enabled'));
  assert.ok(serverSavedToggles.some(({ setting }) => setting.path === 'factory.enabled'));
  assert.ok(serverSavedToggles.some(({ setting }) => setting.path === 'knowledgeGraph.enabled'));
  for (const { section, setting } of serverSavedToggles) {
    const session = dashboardSession();
    const loaded = session.request({ type: 'get-settings' }, 'settings').settings ?? {};
    const original = hydrateFromSettings(SETTINGS_MAP, loaded);
    const flipped = !original[setting.path];
    const edited = { ...original, [setting.path]: flipped };
    const settings = collectDirtyBlocks([section], original, edited);
    const echoed = session.request({ type: 'update-settings', settings }, 'settings-updated').settings ?? {};
    const reloaded = hydrateFromSettings(SETTINGS_MAP, echoed);
    assert.equal(reloaded[setting.path], flipped, `${setting.path} did not persist through a save`);
  }
});


test('factory close-out settings survive dashboard saves and the reviewer model can be cleared', () => {
  const session = dashboardSession();
  const section = SETTINGS_MAP.find((candidate) => candidate.id === 'lanes-factory');
  assert.ok(section);
  const loaded = session.request({ type: 'get-settings' }, 'settings').settings ?? {};
  const original = hydrateFromSettings(SETTINGS_MAP, loaded);
  const edited = { ...original, 'factory.reviewerModel': 'sonnet', 'factory.protectedPaths': ['.github/', '**/AGENTS.md'] };
  const saved = session.request({ type: 'update-settings', settings: collectDirtyBlocks([section], original, edited) }, 'settings-updated').settings ?? {};
  const reloaded = hydrateFromSettings(SETTINGS_MAP, saved);
  assert.equal(reloaded['factory.reviewerModel'], 'sonnet');
  assert.deepEqual(reloaded['factory.protectedPaths'], ['.github/', '**/AGENTS.md']);
  const cleared = session.request({ type: 'update-settings', settings: collectDirtyBlocks([section], reloaded, { ...reloaded, 'factory.reviewerModel': '' }) }, 'settings-updated').settings ?? {};
  assert.equal(hydrateFromSettings(SETTINGS_MAP, cleared)['factory.reviewerModel'], null);
});

test('factory watch, verifier and budget settings round-trip and nullable settings clear', () => {
  const session = dashboardSession();
  const section = SETTINGS_MAP.find((candidate) => candidate.id === 'lanes-factory');
  assert.ok(section);
  const loaded = session.request({ type: 'get-settings' }, 'settings').settings ?? {};
  const original = hydrateFromSettings(SETTINGS_MAP, loaded);
  const edited = { ...original, 'factory.watchWindowMinutes': 120, 'factory.dailyBudgetUsd': 7.5, 'factory.verifierModel': 'sonnet' };
  const saved = session.request({ type: 'update-settings', settings: collectDirtyBlocks([section], original, edited) }, 'settings-updated').settings ?? {};
  const reloaded = hydrateFromSettings(SETTINGS_MAP, saved);
  assert.equal(reloaded['factory.watchWindowMinutes'], 120);
  assert.equal(reloaded['factory.dailyBudgetUsd'], 7.5);
  assert.equal(reloaded['factory.verifierModel'], 'sonnet');
  const zeroBudget = session.request({ type: 'update-settings', settings: collectDirtyBlocks([section], reloaded, { ...reloaded, 'factory.dailyBudgetUsd': 0 }) }, 'settings-updated').settings ?? {};
  assert.equal(hydrateFromSettings(SETTINGS_MAP, zeroBudget)['factory.dailyBudgetUsd'], 0);
  const cleared = session.request({ type: 'update-settings', settings: collectDirtyBlocks([section], reloaded, { ...reloaded, 'factory.dailyBudgetUsd': '', 'factory.verifierModel': '' }) }, 'settings-updated').settings ?? {};
  assert.equal(hydrateFromSettings(SETTINGS_MAP, cleared)['factory.dailyBudgetUsd'], null);
  assert.equal(hydrateFromSettings(SETTINGS_MAP, cleared)['factory.verifierModel'], null);
});
