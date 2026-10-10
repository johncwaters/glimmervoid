import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackendNotifications } from '../server/backend-notifications.ts';
import { createSessionFactory } from '../server/session-factory.ts';
import type { GlimmervoidConfig } from '../server/config-store.ts';
import { HookRouter } from '../detection/hook-source.ts';
import { RTK_PATH_ENV } from '../session/core/rtk-hook-core.ts';
import { exitablePty } from './helpers/fake-pty.ts';
import type { SpawnCall } from './helpers/fake-pty.ts';

test('notification wiring preserves zero at boot and reload and retains the default suppression window', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-debounce-zero-'));
  const config: { notifyDebounceMs?: number } = { notifyDebounceMs: 0 };
  const deliveredCategories: string[] = [];
  const notifications = createBackendNotifications({
    config,
    configStore: { configPath: path.join(directory, 'config.json') },
    sessions: new Map(),
    controlWss: { clients: [], on: () => {} },
    dataWss: { clients: [], on: () => {} },
    broadcastControl: () => {},
    logger: { warn: () => {} },
  });
  const manager = notifications.notificationManager;
  manager.registerChannel('probe', (_session, category) => { deliveredCategories.push(category); });
  try {
    manager.trigger('session', 'complete', 'finished');
    manager.acknowledge('session');
    manager.trigger('session', 'complete', 'finished');
    assert.equal(deliveredCategories.length, 2);
    delete config.notifyDebounceMs;
    notifications.applySettings();
    manager.acknowledge('session');
    manager.trigger('session', 'complete', 'finished');
    assert.equal(deliveredCategories.length, 2);
    config.notifyDebounceMs = 0;
    notifications.applySettings();
    manager.acknowledge('session');
    manager.trigger('session', 'complete', 'finished');
    assert.equal(deliveredCategories.length, 3);
  } finally {
    notifications.heartbeat.stop();
    notifications.telegramChannel.destroy();
    manager.destroy();
    await notifications.telegramOutbox.idle();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const agent of ['claude-code', 'codex']) {
  test(`${agent} restarts resolve RTK from current factory settings and rewrite hook injection`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-rtk-restart-'));
    const config: GlimmervoidConfig = { projects: [], rtk: false, recordSignals: false, saneYolo: false };
    const factory = createSessionFactory({
      configStore: { configPath: path.join(directory, 'config.json') },
      getConfig: () => config,
      hookRouter: new HookRouter(),
      getHookPort: () => 41234,
      getGitWorkspace: () => null,
      getPlanReviewPort: () => null,
      resolveHookTools: currentConfig => currentConfig.rtk ? [{ id: 'rtk', binPath: '/fixture/rtk' }] : [],
      getUserHooks: () => [],
    });
    const session = factory({ id: 'a0000000-0000-4000-8000-000000000001', name: 'RTK restart', path: directory, agent }, { ...config });
    const spawnedProcesses: ReturnType<typeof exitablePty>[] = [];
    const spawnCalls: SpawnCall[] = [];
    session._spawnCommand = { path: process.execPath, kind: 'exe' };
    session._ptySpawn = (file, args, opts) => {
      spawnCalls.push({ file, args, opts: opts as SpawnCall['opts'] });
      const spawnedProcess = exitablePty(0);
      spawnedProcesses.push(spawnedProcess);
      return spawnedProcess;
    };
    const assertRtkInjection = (isEnabled: boolean) => {
      const lastSpawn = spawnCalls.at(-1);
      assert.ok(lastSpawn);
      assert.equal(lastSpawn.opts.env[RTK_PATH_ENV], isEnabled ? '/fixture/rtk' : undefined);
      if (agent === 'codex') {
        assert.equal(lastSpawn.args.some(argument => argument.startsWith('hooks.PreToolUse=') && argument.includes(" rtk'")), isEnabled);
        return;
      }
      const settingsArgument = lastSpawn.args.indexOf('--settings');
      assert.ok(settingsArgument >= 0);
      assert.equal(fs.readFileSync(lastSpawn.args[settingsArgument + 1], 'utf8').includes('/fixture/rtk hook claude'), isEnabled);
    };
    try {
      await session.start();
      assertRtkInjection(false);
      spawnedProcesses.at(-1)?.fireExit();
      config.rtk = true;
      assert.equal(session.restart(), true);
      await session.start();
      assertRtkInjection(true);
      spawnedProcesses.at(-1)?.fireExit();
      config.rtk = false;
      assert.equal(session.restart({ fresh: true }), true);
      await session.start();
      assertRtkInjection(false);
      spawnedProcesses.at(-1)?.fireExit();
      assert.equal(spawnCalls.length, 3);
    } finally {
      session.destroy();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
