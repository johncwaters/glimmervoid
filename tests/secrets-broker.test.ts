import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createBackend } from '../server/backend/backend.ts';
import { createSecretsBroker } from '../server/secrets/secrets-broker.ts';
import { git, hasGit } from './helpers/git-fixture.ts';
import { closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { settleBackendShutdown } from './helpers/lanes.ts';
import { waitFor } from './helpers/wait-for.ts';

const SESSION_ID = 'secrets-restart-session';
const APPROVED_VALUE = 'kept-from-before-the-restart';
const UNAPPROVED_VALUE = 'the-project-own-setting';

test('a session wired after a restart masks the approved values already in the env file of its worktree', { skip: !hasGit() }, async () => {
  const previousConfigPath = process.env.GLIMMERVOID_CONFIG;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-secrets-restart-'));
  const projectDir = path.join(tmpDir, 'project');
  const worktreeDir = path.join(tmpDir, 'worktree');
  fs.mkdirSync(projectDir);
  git(['init', '-q'], projectDir);
  git(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'first'], projectDir);
  git(['worktree', 'add', '-q', worktreeDir, '-b', `glimmervoid/session/${SESSION_ID}`], projectDir);
  fs.writeFileSync(path.join(worktreeDir, '.env.local'), `APPROVED_KEY='${APPROVED_VALUE}'\nOWN_SETTING='${UNAPPROVED_VALUE}'\n`, 'utf8');
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    projects: [{ id: SESSION_ID, name: 'secrets restart', path: projectDir }],
    repoRoots: [],
    autoResume: false,
    secrets: { byProject: { [projectDir]: { APPROVED_KEY: { reference: 'op://vault/item/field', isAllowed: true } } } },
  }, null, 2), 'utf8');
  process.env.GLIMMERVOID_CONFIG = configPath;
  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await listenOnLoopback(server);
  try {
    const session = backend.getSession(SESSION_ID);
    assert.ok(session, 'the boot loop created the configured session');
    await waitFor(() => session.effectiveCwd() === worktreeDir, 'the session took its worktree back', 10_000);
    session.transition('user_start');
    await waitFor(() => session.deliveredSecretValues().length > 0, 'the session masks were seeded from the env file in its worktree', 10_000);
    assert.deepEqual([...session.deliveredSecretValues()], [APPROVED_VALUE], 'only the approved name is masked');
  } finally {
    await settleBackendShutdown(backend);
    server.closeAllConnections();
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (previousConfigPath === undefined) delete process.env.GLIMMERVOID_CONFIG;
    if (previousConfigPath !== undefined) process.env.GLIMMERVOID_CONFIG = previousConfigPath;
  }
});

test('a vault read that ends after the operator corrected the reference leaves the corrected approval saved', async () => {
  const otherSession = { ...NEEDING_SESSION, id: 'other-needing-session' };
  const correctedSecrets = { byProject: { [NEEDING_SESSION.project]: { API_KEY: { reference: 'op://vault/corrected/field', isAllowed: true } } } };
  let savedSecrets: unknown = { byProject: { [NEEDING_SESSION.project]: { API_KEY: { reference: 'op://vault/deleted/field', isAllowed: true } } } };
  let releaseStaleRead = (): void => {};
  const staleReadReleased = new Promise<void>((resolve) => { releaseStaleRead = resolve; });
  const broker = createSecretsBroker({
    readSecrets: () => savedSecrets,
    writeSecrets: async (mutate) => {
      const nextSecrets = mutate(savedSecrets);
      if (nextSecrets === null) return false;
      savedSecrets = nextSecrets;
      return true;
    },
    isCompanionOnline: () => true,
    readVault: async (items) => {
      await staleReadReleased;
      return items.map((item) => ({ name: item.name, failure: { kind: 'not-found' as const, message: 'no such item' } }));
    },
  });
  const staleNeed = broker.need(otherSession, ['API_KEY']);
  savedSecrets = correctedSecrets;
  releaseStaleRead();
  const reply = await staleNeed;
  assert.deepEqual(savedSecrets, correctedSecrets);
  assert.deepEqual(reply.results.map((result) => result.status), ['failed']);
  assert.deepEqual(broker.requestsSnapshot(), {}, 'no card comes back for a reference that was already replaced');
});

const NEEDING_SESSION = { id: 'needing-session', project: '/projects/app', cwd: '/projects/app' };

function brokerWithMissingVaultItem(initialSecrets: Record<string, unknown>) {
  let savedSecrets: unknown = initialSecrets;
  const broker = createSecretsBroker({
    readSecrets: () => savedSecrets,
    writeSecrets: async (mutate) => {
      const nextSecrets = mutate(savedSecrets);
      if (nextSecrets === null) return false;
      savedSecrets = nextSecrets;
      return true;
    },
    isCompanionOnline: () => true,
    readVault: async (items) => items.map((item) => ({ name: item.name, failure: { kind: 'not-found' as const, message: 'no such item' } })),
  });
  return { broker, savedSecrets: () => savedSecrets };
}

test('Allow with a reference the vault does not have is refused and saves nothing', async () => {
  const { broker, savedSecrets } = brokerWithMissingVaultItem({});
  await broker.need(NEEDING_SESSION, ['API_KEY']);
  const refusal = await broker.decide({ id: NEEDING_SESSION.id, isAllowed: true, referenceByName: { API_KEY: 'op://vault/typo/field' }, valueByName: {}, newItemsVault: '' });
  assert.equal(refusal, 'The vault has no item at the reference given for API_KEY.');
  assert.deepEqual(savedSecrets(), {});
  assert.deepEqual(broker.requestsSnapshot(), { [NEEDING_SESSION.id]: ['API_KEY'] }, 'the card stays for a corrected reference');
});

test('an approved reference the vault no longer has brings the card back instead of failing forever', async () => {
  const { broker } = brokerWithMissingVaultItem({ byProject: { [NEEDING_SESSION.project]: { API_KEY: { reference: 'op://vault/deleted/field', isAllowed: true } } } });
  const reply = await broker.need(NEEDING_SESSION, ['API_KEY']);
  assert.deepEqual(reply.results.map((result) => result.status), ['pending']);
  assert.match(reply.results[0]?.note ?? '', /the operator was asked for a new one/);
  assert.deepEqual(broker.requestsSnapshot(), { [NEEDING_SESSION.id]: ['API_KEY'] });
  assert.deepEqual(broker.approvalRows(), []);
});
