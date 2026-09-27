import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { GlimmervoidConfig } from '../server/config-store.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';
import { ClientMessage } from '../shared/contracts/control-messages.ts';

function addSessionUnder(skipPermissionsByDefault: boolean | undefined, requestedSkip: unknown) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-add-session-perms-'));
  try {
    const config: GlimmervoidConfig = { projects: [], skipPermissionsByDefault };
    const reloadedConfigs: GlimmervoidConfig[] = [];
    const server = createControlServer(controlDeps(config, { applyConfigReload: (fresh) => { reloadedConfigs.push(fresh); } }));
    const connection = connectControl(server);
    const message: Record<string, unknown> = { type: 'add-session', name: 'repo', path: projectDir };
    if (requestedSkip !== undefined) message.dangerouslySkipPermissions = requestedSkip;
    connection.send(message);
    return { projects: config.projects, reloadedConfigs };
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

test('add-session stores an explicit true on the project even when the machine default is off', () => {
  const { projects } = addSessionUnder(false, true);
  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.dangerouslySkipPermissions, true);
});

test('add-session stores an explicit false on the project even when the machine default is on', () => {
  const { projects } = addSessionUnder(true, false);
  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.dangerouslySkipPermissions, false);
});

test('add-session without a permission choice records the machine default, off when it is unset', () => {
  assert.equal(addSessionUnder(undefined, undefined).projects[0]?.dangerouslySkipPermissions, false);
  assert.equal(addSessionUnder(true, undefined).projects[0]?.dangerouslySkipPermissions, true);
});

test('add-session drops a non-boolean permission choice before saving anything', () => {
  const { projects, reloadedConfigs } = addSessionUnder(true, 'yes');
  assert.deepEqual(projects, []);
  assert.deepEqual(reloadedConfigs, []);
});

test('the add-session contract accepts a boolean permission choice and rejects any other value', () => {
  const base = { type: 'add-session', name: 'repo', path: '/repo' };
  assert.equal(ClientMessage.safeParse({ ...base, dangerouslySkipPermissions: true }).success, true);
  assert.equal(ClientMessage.safeParse({ ...base, dangerouslySkipPermissions: false }).success, true);
  assert.equal(ClientMessage.safeParse(base).success, true);
  assert.equal(ClientMessage.safeParse({ ...base, dangerouslySkipPermissions: 'true' }).success, false);
});

test('a dashboard save that flips the machine default reconciles sessions at once, and one that keeps it does not', () => {
  const config: GlimmervoidConfig = { projects: [] };
  const reloadedConfigs: GlimmervoidConfig[] = [];
  const server = createControlServer(controlDeps(config, { applyConfigReload: (fresh) => { reloadedConfigs.push(fresh); } }));
  const connection = connectControl<{ type: string }>(server);

  connection.send({ type: 'update-settings', settings: { skipPermissionsByDefault: true } });
  assert.equal(config.skipPermissionsByDefault, true);
  assert.equal(reloadedConfigs.length, 1);

  connection.send({ type: 'update-settings', settings: { debugMode: true } });
  assert.equal(reloadedConfigs.length, 1);
});
