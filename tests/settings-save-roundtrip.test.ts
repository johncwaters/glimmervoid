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
