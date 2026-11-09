import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { waitFor } from '../helpers/wait-for.ts';
import { installGhShim } from './support/gh-shim.ts';
import { startRecordingFake } from './support/recording-fake.ts';
import { assertCleanLog, startServer } from './support/server-process.ts';

const SCENARIO_SEEDS = ['cloud/link/watcher-link.ts', 'cloud/doorman/ensure-doorman.ts', 'server/github/github-store-wiring.ts'];

const REFUSED_TOKEN = 'e2e-refused-token';
const ACCEPTED_TOKEN = 'e2e-accepted-token';
const NUDGE_DEADLINE_MS = 20_000;
const EXPECTED_WATCHER_WARNINGS = [/\[watcher\] probe github:notifications is failing: answered 401/];

function setGithubReadToken(home: string, readToken: string): void {
  const configPath = path.join(home, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.github = { ...config.github, readToken };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function notificationsReadsOf(ghCalls: readonly string[]): number {
  return ghCalls.filter((call) => call.includes('api -i -X GET notifications')).length;
}

test('the watcher probes nothing without a token, then probes the GitHub API and nudges its lane when a probe recovers', async (t) => {
  const fakeGithub = await startRecordingFake((request) => {
    if (request.authorization !== `Bearer ${ACCEPTED_TOKEN}`) return { status: 401, body: '{"message":"Bad credentials"}' };
    return { status: 200, headers: { etag: '"e2e-notifications"' }, body: '[]' };
  });
  t.after(() => fakeGithub.close());
  const ghShim = installGhShim(process.env.GLIMMERVOID_HOME ?? '.');
  const server = await startServer({
    scenarioName: 'watcher',
    testContext: t,
    extraEnvironment: { GLIMMERVOID_GITHUB_API_BASE: fakeGithub.origin },
    pathPrefix: ghShim.directory,
  });

  await server.waitForLogLine(/\[watcher\] no GitHub read token/, 'the missing token line');
  await server.waitForLogLine(/\[watcher\] delivered probe set \w+ with 0 probes/, 'an empty probe set');
  assert.equal(fakeGithub.requests.length, 0, 'the watcher reached GitHub without a token');

  setGithubReadToken(server.home, REFUSED_TOKEN);
  await server.waitForLogLine(/\[watcher\] probe github:notifications is failing/, 'the refused probe', NUDGE_DEADLINE_MS);
  const notificationsReadsBeforeRecovery = notificationsReadsOf(ghShim.calls());

  setGithubReadToken(server.home, ACCEPTED_TOKEN);
  await server.waitForLogLine(/\[watcher\] github-store: github:notifications recovered/, 'the recovered nudge', NUDGE_DEADLINE_MS);
  await waitFor(
    () => notificationsReadsOf(ghShim.calls()) > notificationsReadsBeforeRecovery,
    'the nudged lane reading notifications through gh again',
    NUDGE_DEADLINE_MS,
  );

  const probedPaths = new Set(fakeGithub.requests.map((request) => request.path));
  assert.deepEqual([...probedPaths], ['/notifications'], 'the watcher probed something other than notifications');
  const stopped = await server.stopProcessGroup('SIGTERM');
  t.diagnostic(`boot ${server.bootMs} ms, shutdown ${stopped.shutdownMs} ms`);
  assert.equal(stopped.exitCode, 0, server.logText());
  assertCleanLog(server.logText(), EXPECTED_WATCHER_WARNINGS);
});

export { SCENARIO_SEEDS };
