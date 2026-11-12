import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createBackend } from '../server/backend/backend.ts';
import { createSecretsBroker } from '../server/secrets/secrets-broker.ts';
import { needExitCode } from '../server/secrets/core/secrets-broker-core.ts';
import { createWrittenSecretNames } from '../server/secrets/written-secret-names.ts';
import type { SecretRequestCard, SecretSource } from '../shared/contracts/secrets.ts';
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
  const worktreeDir = path.join(fs.realpathSync(tmpDir), 'worktree');
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
    secrets: { byProject: { [projectDir]: { APPROVED_KEY: { isAllowed: true } } } },
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

const NEEDING_SESSION = { id: 'needing-session', project: '/projects/app', cwd: '/projects/app' };
const SOURCE = { manager: '1password', lookIn: 'Agents' } as const;

interface FakeWorld {
  source: SecretSource | null;
  savedSecrets: unknown;
  valueByName: Record<string, string>;
  readNames: string[];
  envFileWrites: Record<string, string>[];
}

function brokerOver(world: FakeWorld) {
  const cardEvents: Array<SecretRequestCard | null> = [];
  const broker = createSecretsBroker({
    readSecrets: () => world.savedSecrets,
    writeSecrets: async (mutate) => {
      const nextSecrets = mutate(world.savedSecrets);
      if (nextSecrets === null) return false;
      world.savedSecrets = nextSecrets;
      return true;
    },
    currentSource: () => world.source,
    readSecret: async (_source, name) => {
      world.readNames.push(name);
      const value = world.valueByName[name];
      if (value === undefined) return { failure: { kind: 'not-found', message: `No ${name} in 1Password, vault Agents`, detail: `"${name}" isn't an item in the "Agents" vault` } };
      return { value };
    },
    writeEnvFile: async (_directory, valuesByName) => {
      world.envFileWrites.push({ ...valuesByName });
      return { ok: true, envFile: '/projects/app/.env.local' };
    },
  });
  broker.events.on('card-changed', ({ card }: { card: SecretRequestCard | null }) => cardEvents.push(card));
  return { broker, cardEvents };
}

function freshWorld(overrides: Partial<FakeWorld> = {}): FakeWorld {
  return { source: SOURCE, savedSecrets: {}, valueByName: {}, readNames: [], envFileWrites: [], ...overrides };
}

test('Allow once reads names in request order, stops at the first missing one with its detail on the card, and saves no approval', async () => {
  const world = freshWorld({ valueByName: { FIRST_KEY: 'first-value', THIRD_KEY: 'third-value' } });
  const { broker, cardEvents } = brokerOver(world);
  const asked = await broker.need(NEEDING_SESSION, ['FIRST_KEY', 'MISSING_KEY', 'THIRD_KEY'], 'To run the replay');
  assert.deepEqual(asked.results.map((result) => result.status), ['pending', 'pending', 'pending']);
  assert.equal(broker.requestsSnapshot()[NEEDING_SESSION.id]?.reason, 'To run the replay');

  assert.equal(await broker.decide({ id: NEEDING_SESSION.id, choice: 'allow-once', names: ['FIRST_KEY', 'MISSING_KEY', 'THIRD_KEY'] }), null);
  await waitFor(() => broker.requestsSnapshot()[NEEDING_SESSION.id]?.phase === 'failed', 'the card shows the failed read');

  const failedCard = broker.requestsSnapshot()[NEEDING_SESSION.id];
  assert.deepEqual(world.readNames, ['FIRST_KEY', 'MISSING_KEY']);
  assert.deepEqual(world.envFileWrites, [{ FIRST_KEY: 'first-value' }]);
  assert.deepEqual(failedCard?.names, ['MISSING_KEY', 'THIRD_KEY']);
  assert.match(failedCard?.failure?.message ?? '', /No MISSING_KEY in 1Password, vault Agents\. FIRST_KEY was written to the env file; the rest were not\./);
  assert.match(failedCard?.failure?.detail ?? '', /isn't an item in the "Agents" vault/);
  assert.ok(cardEvents.some((card) => card?.phase === 'reading' && card.readingName === 'MISSING_KEY'), 'the card named the name being read');
  assert.deepEqual(world.savedSecrets, {});

  const again = await broker.need(NEEDING_SESSION, ['FIRST_KEY']);
  assert.deepEqual(again.results.map((result) => result.status), ['delivered']);
  assert.deepEqual(world.readNames, ['FIRST_KEY', 'MISSING_KEY'], 'a delivered name answers from memory without a second read');
});

test('with no source chosen the agent gets no-source, the card asks for a source, and Allow is refused until one is set', async () => {
  const world = freshWorld({ source: null, valueByName: { API_KEY: 'the-value' } });
  const { broker } = brokerOver(world);
  const reply = await broker.need(NEEDING_SESSION, ['API_KEY']);
  assert.deepEqual(reply.results.map((result) => result.status), ['no-source']);
  assert.equal(needExitCode(Object.fromEntries(reply.results.map((result) => [result.name, result.status]))), 30);
  assert.equal(broker.requestsSnapshot()[NEEDING_SESSION.id]?.phase, 'needs-source');
  assert.match(await broker.decide({ id: NEEDING_SESSION.id, choice: 'allow-always', names: ['API_KEY'] }) ?? '', /Settings > Vault/);
  assert.deepEqual(world.savedSecrets, {});

  world.source = SOURCE;
  assert.equal(broker.requestsSnapshot()[NEEDING_SESSION.id]?.phase, 'asking');
  assert.equal(await broker.decide({ id: NEEDING_SESSION.id, choice: 'allow-always', names: ['API_KEY'] }), null);
  await waitFor(() => broker.requestsSnapshot()[NEEDING_SESSION.id] === undefined, 'the card closes after the read');
  assert.deepEqual(world.savedSecrets, { byProject: { [NEEDING_SESSION.project]: { API_KEY: { isAllowed: true } } } });

  const otherSession = { ...NEEDING_SESSION, id: 'other-session' };
  const otherReply = await broker.need(otherSession, ['API_KEY']);
  assert.deepEqual(otherReply.results.map((result) => result.status), ['delivered']);
  assert.deepEqual(broker.requestsSnapshot(), {}, 'an always-allowed name reads without a card in another session');
});

test('Deny holds the name for the project and closes the card', async () => {
  const world = freshWorld({ valueByName: { API_KEY: 'the-value' } });
  const { broker } = brokerOver(world);
  await broker.need(NEEDING_SESSION, ['API_KEY']);
  assert.equal(await broker.decide({ id: NEEDING_SESSION.id, choice: 'deny', names: ['API_KEY'] }), null);
  const reply = await broker.need({ ...NEEDING_SESSION, id: 'other-session' }, ['API_KEY']);
  assert.deepEqual(reply.results.map((result) => result.status), ['denied']);
  assert.deepEqual(broker.requestsSnapshot(), {});
  assert.deepEqual(world.readNames, []);
});

test('a name the agent adds after the operator looked at the card is neither read nor saved by that click', async () => {
  const world = freshWorld({ valueByName: { SHOWN_KEY: 'shown-value', LATE_KEY: 'late-value' } });
  const { broker } = brokerOver(world);
  await broker.need(NEEDING_SESSION, ['SHOWN_KEY']);
  await broker.need(NEEDING_SESSION, ['LATE_KEY']);
  assert.equal(await broker.decide({ id: NEEDING_SESSION.id, choice: 'allow-always', names: ['SHOWN_KEY'] }), null);
  await waitFor(() => broker.requestsSnapshot()[NEEDING_SESSION.id]?.phase === 'asking', 'the card goes back to asking for the late name');
  assert.deepEqual(world.readNames, ['SHOWN_KEY']);
  assert.deepEqual(broker.requestsSnapshot()[NEEDING_SESSION.id]?.names, ['LATE_KEY']);
  assert.deepEqual(world.savedSecrets, { byProject: { [NEEDING_SESSION.project]: { SHOWN_KEY: { isAllowed: true } } } });
});

test('a value delivered with Allow once is masked again after a restart, though no approval was saved', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-written-names-'));
  try {
    const world = freshWorld({ valueByName: { ONCE_KEY: 'once-value' } });
    const envValuesFor = async () => Object.assign({}, ...world.envFileWrites);
    const brokerWithStore = () => createSecretsBroker({
      readSecrets: () => world.savedSecrets,
      writeSecrets: async () => false,
      currentSource: () => world.source,
      readSecret: async (_source, name) => ({ value: world.valueByName[name] ?? '' }),
      writeEnvFile: async (_directory, valuesByName) => {
        world.envFileWrites.push({ ...valuesByName });
        return { ok: true, envFile: '/projects/app/.env.local' };
      },
      readEnvValues: envValuesFor,
      writtenNames: createWrittenSecretNames({ filePath: path.join(stateDir, 'env-file-names.json') }),
    });
    const before = brokerWithStore();
    await before.need(NEEDING_SESSION, ['ONCE_KEY']);
    await before.decide({ id: NEEDING_SESSION.id, choice: 'allow-once', names: ['ONCE_KEY'] });
    await waitFor(() => before.deliveredValuesOf(NEEDING_SESSION.id).length > 0, 'the value was delivered');

    const afterRestart = brokerWithStore();
    assert.equal(await afterRestart.seedMasks(NEEDING_SESSION), null);
    assert.deepEqual(afterRestart.deliveredValuesOf(NEEDING_SESSION.id), ['once-value']);
    assert.deepEqual(world.savedSecrets, {});
    assert.equal(fs.readFileSync(path.join(stateDir, 'env-file-names.json'), 'utf8').includes('once-value'), false, 'the record holds names only');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
