import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { GlimmervoidConfig } from '../server/config-store.ts';
import type { ControlHandlerDeps } from '../server/control-handlers.ts';
import { createGitWorkspace } from '../server/git/git-workspace.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';
import { git } from './helpers/git-fixture.ts';
import { ClientMessage } from '../shared/contracts/control-messages.ts';
import type { Session } from '../session/sessions.ts';
import { plainSession } from './helpers/fake-session.ts';

function addSessionUnder(skipPermissionsByDefault: boolean | undefined, requestedSkip: unknown) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-add-session-perms-'));
  try {
    const config: GlimmervoidConfig = { projects: [], skipPermissionsByDefault };
    const reloadedConfigs: GlimmervoidConfig[] = [];
    const server = createControlServer(controlDeps(config, { applyConfigReload: (fresh) => { reloadedConfigs.push(fresh); } }));
    const connection = connectControl(server);
    const message: Record<string, unknown> = { type: 'add-session', name: 'repo', path: projectDir, runInPlace: true };
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

type CoderEnvPort = NonNullable<ControlHandlerDeps['coderEnv']>;

function checkoutWithOrigin(context: test.TestContext): { checkoutPath: string; originPath: string } {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-add-remote-session-'));
  context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const originPath = path.join(fixtureRoot, 'origin.git');
  const checkoutPath = path.join(fixtureRoot, 'repo');
  git(['init', '--bare', '-q', '-b', 'main', originPath]);
  git(['init', '-q', '-b', 'main', checkoutPath]);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'first'], checkoutPath);
  git(['remote', 'add', 'origin', originPath], checkoutPath);
  return { checkoutPath, originPath };
}

function remoteAddSession(reserveResult: Awaited<ReturnType<CoderEnvPort['reserve']>>) {
  const config: GlimmervoidConfig = { projects: [] };
  const reserveCalls: Parameters<CoderEnvPort['reserve']>[0][] = [];
  const provisionCalls: Parameters<CoderEnvPort['provision']>[0][] = [];
  const coderEnv: CoderEnvPort = {
    availableEnvironments: () => [],
    reserve: async (request) => {
      reserveCalls.push(request);
      return reserveResult;
    },
    provision: async (request) => {
      provisionCalls.push(request);
      return { ok: true, mapping: request.mapping };
    },
    settleRemoval: async () => ({ ok: true }),
  };
  const server = createControlServer(controlDeps(config, { coderEnv, remoteRepoGit: createGitWorkspace() }));
  const connection = connectControl<{ type: string; ok?: boolean; error?: string | null }>(server);
  return { config, connection, reserveCalls, provisionCalls };
}

test('a remote pick saves the project with the reserved mapping and provisions that same mapping', async (context) => {
  const { checkoutPath, originPath } = checkoutWithOrigin(context);
  const mapping = { name: 'remote', workspace: 'gv-0123456789ab', remotePort: 40_001, branch: 'glimmervoid/session/p-test' };
  const { config, connection, reserveCalls, provisionCalls } = remoteAddSession({ ok: true, mapping });
  await connection.send({ type: 'add-session', requestId: 'remote-1', name: 'repo', path: checkoutPath, environment: 'remote' });
  assert.deepEqual(connection.sent.at(-1), { type: 'add-session-result', requestId: 'remote-1', ok: true, error: null });
  assert.deepEqual(reserveCalls, [{ projectId: 'p-test', environmentName: 'remote', branch: 'glimmervoid/session/p-test', liveCount: 0 }]);
  assert.deepEqual(config.projects.map((project) => [project.id, project.environment]), [['p-test', mapping]]);
  assert.deepEqual(provisionCalls, [{ projectId: 'p-test', mapping, repoRemoteUrl: originPath, baseBranch: 'main' }]);
});

test('a maxLive refusal from reserve replies with the reason naming the count and saves no project', async (context) => {
  const { checkoutPath } = checkoutWithOrigin(context);
  const reason = 'remote already has 2 of 2 live workspaces; close one first';
  const { config, connection, provisionCalls } = remoteAddSession({ ok: false, reason });
  await connection.send({ type: 'add-session', requestId: 'remote-2', name: 'repo', path: checkoutPath, environment: 'remote' });
  assert.deepEqual(connection.sent.at(-1), { type: 'add-session-result', requestId: 'remote-2', ok: false, error: reason });
  assert.deepEqual(config.projects, []);
  assert.deepEqual(provisionCalls, []);
});

test('the add-session contract accepts an environment name and rejects a non-string environment', () => {
  const base = { type: 'add-session', name: 'repo', path: '/srv/repo' };
  assert.equal(ClientMessage.safeParse({ ...base, environment: 'remote' }).success, true);
  assert.equal(ClientMessage.safeParse({ ...base, environment: 3 }).success, false);
});

test('removing a remote session stops its agent before the remote work check and keeps the project when the check refuses', async (context) => {
  const mapping = { name: 'remote', workspace: 'gv-0123456789ab', remotePort: 40_001, branch: 'feature' };
  const config: GlimmervoidConfig = { projects: [{ id: 'p-remote', name: 'repo', path: '/repo', environment: mapping }] };
  const steps: string[] = [];
  const session = plainSession('p-remote');
  context.after(() => session.destroy());
  session.killSession = () => { steps.push('stop agent'); return true; };
  const reason = `Branch feature in Coder workspace ${mapping.workspace} has uncommitted changes`;
  const coderEnv: CoderEnvPort = {
    availableEnvironments: () => [],
    reserve: async () => ({ ok: false, reason: 'unused' }),
    provision: async () => ({ ok: false, reason: 'unused' }),
    settleRemoval: async () => {
      steps.push('check remote work');
      return { ok: false, reason, canDiscardRemoteWork: true };
    },
  };
  const server = createControlServer(controlDeps(config, { coderEnv, sessions: new Map<string, Session>([[session.id, session]]) }));
  const connection = connectControl<{ type: string }>(server);
  await connection.send({ type: 'remove-session', requestId: 'remove-1', id: session.id });
  assert.deepEqual(steps, ['stop agent', 'check remote work']);
  assert.deepEqual(connection.sent.at(-1), { type: 'remove-session-result', requestId: 'remove-1', ok: false, error: reason, canDiscardRemoteWork: true });
  assert.deepEqual(config.projects.map((project) => project.id), ['p-remote']);
});
