import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createBackend } from '../server/backend/backend.ts';
import { createSecretsBroker } from '../server/secrets/secrets-broker.ts';
import { mcpLaunchFor } from '../mcp/core/agent-config.ts';
import { NO_OPERATOR_MCP_SERVER_NAMES, packMcpLaunchOf, packMcpServersForAgent } from '../server/packs/core/pack-core.ts';
import { buildAgentEnv } from '../session/core/spawn-env.ts';
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

const NEEDING_SESSION = { id: 'needing-session', project: '/projects/app', cwd: '/projects/app', isRemote: false };

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

test('a pack server secret linked once in Settings reaches every agent by environment variable name, never argv, and a server whose secret is unlinked stays out', async () => {
  const tokenValue = 'executor-bearer-value';
  let savedSecrets: unknown = {};
  const broker = createSecretsBroker({
    readSecrets: () => savedSecrets,
    writeSecrets: async (mutate) => {
      const nextSecrets = mutate(savedSecrets);
      if (nextSecrets === null) return false;
      savedSecrets = nextSecrets;
      return true;
    },
    isCompanionOnline: () => true,
    readVault: async (items) => items.map((item) => (item.reference === 'op://dev/executor/token' ? { name: item.name, value: tokenValue } : { name: item.name, failure: { kind: 'not-found' as const, message: 'no such item' } })),
    declaredPackSecrets: () => [{ name: 'EXECUTOR_TOKEN', packs: ['executor'] }, { name: 'OTHER_TOKEN', packs: ['other'] }],
  });
  assert.equal(await broker.linkPackSecret({ name: 'EXECUTOR_TOKEN', reference: 'op://dev/executor/typo' }), 'The vault has no item at the reference given for EXECUTOR_TOKEN.');
  assert.equal(await broker.linkPackSecret({ name: 'EXECUTOR_TOKEN', reference: 'op://dev/executor/token' }), null);
  assert.deepEqual(broker.approvalsMessage().packSecrets, [
    { name: 'EXECUTOR_TOKEN', packs: ['executor'], reference: 'op://dev/executor/token' },
    { name: 'OTHER_TOKEN', packs: ['other'], reference: null },
  ]);
  const servers = [
    { name: 'executor', url: 'http://127.0.0.1:4312/mcp', secret: 'EXECUTOR_TOKEN' },
    { name: 'other', url: 'https://other.example/mcp', secret: 'OTHER_TOKEN' },
    { name: 'open', url: 'https://open.example/mcp' },
  ];
  const secretsRead = await broker.readPackSecrets('pack-session', ['EXECUTOR_TOKEN', 'OTHER_TOKEN']);
  assert.match(secretsRead.problemByName.OTHER_TOKEN ?? '', /not linked/);
  assert.deepEqual(broker.deliveredValuesOf('pack-session'), [tokenValue], 'the session masks the token in its output');
  const launch = packMcpLaunchOf(servers, secretsRead.valueByName);
  assert.deepEqual(launch.servers.map((server) => server.name), ['executor', 'open']);
  assert.deepEqual(launch.env, { GLIMMERVOID_PACK_EXECUTOR_TOKEN: tokenValue });
  for (const agentId of ['claude-code', 'codex']) {
    const argv = mcpLaunchFor({ agentId, listenerPort: null, sessionId: 'pack-session', agentToken: null, packServers: launch.servers }).args.join(' ');
    assert.ok(argv.includes('GLIMMERVOID_PACK_EXECUTOR_TOKEN'), `${agentId} names the token variable`);
    assert.ok(!argv.includes(tokenValue), `${agentId} argv never holds the token`);
  }
  assert.equal(await broker.linkPackSecret({ name: 'EXECUTOR_TOKEN', reference: '' }), null);
  assert.deepEqual((await broker.readPackSecrets('pack-session', ['EXECUTOR_TOKEN'])).valueByName, {});
});

test('a pack secret reaches only agents that render pack servers, never a child glimmervoid, and a late or stuck vault companion neither drops it at boot nor holds the spawn queue', async () => {
  const pack = { header: { name: 'executor' }, mcp: { ok: true, value: { servers: [{ name: 'executor', url: 'https://executor.example/mcp', secret: 'EXECUTOR_TOKEN' }] } } };
  for (const agentId of ['grok', 'my-custom-cli']) assert.deepEqual(packMcpServersForAgent(agentId, [pack as never], NO_OPERATOR_MCP_SERVER_NAMES), [], `${agentId} gets no pack server and so no token`);
  assert.deepEqual(Object.keys(buildAgentEnv({ PATH: '/bin', GLIMMERVOID_PACK_EXECUTOR_TOKEN: 'parent-token' }, {}, {})), ['PATH']);
  const linkedSecrets = { packs: { EXECUTOR_TOKEN: { reference: 'op://dev/executor/token', isAllowed: true } } };
  let isOnline = false;
  const bootBroker = createSecretsBroker({ readSecrets: () => linkedSecrets, writeSecrets: async () => true, isCompanionOnline: () => isOnline, readVault: async (items) => items.map((item) => ({ name: item.name, value: 'boot-token' })) });
  setTimeout(() => { isOnline = true; }, 600);
  assert.deepEqual((await bootBroker.readPackSecrets('resumed-session', ['EXECUTOR_TOKEN'])).valueByName, { EXECUTOR_TOKEN: 'boot-token' });
  const stuckBroker = createSecretsBroker({ readSecrets: () => linkedSecrets, writeSecrets: async () => true, isCompanionOnline: () => true, readVault: () => new Promise(() => {}), packSecretReadTimeoutMs: 300 });
  const stuckRead = await stuckBroker.readPackSecrets('stuck-session', ['EXECUTOR_TOKEN']);
  assert.deepEqual(stuckRead.valueByName, {});
  assert.match(stuckRead.problemByName.EXECUTOR_TOKEN ?? '', /did not answer/);
});
