import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { credentialStoreKey, directionKey, signedHeaders } from '../cloud/link/core/link-signing-core.ts';
import WebSocket, { WebSocketServer } from 'ws';
import { createDoorman } from '../cloud/doorman/doorman.ts';
import { ensureDoorman, localDoormanUrl } from '../cloud/doorman/ensure-doorman.ts';
import { createRemoteWatcherStarter } from '../cloud/link/remote-watcher-starter.ts';
import { createWatcherLink } from '../cloud/link/watcher-link.ts';
import { createNudgeSender, createProbeRunner } from '../cloud/watcher/probe-runner.ts';
import { createWatcherHome } from '../cloud/watcher/watcher-home.ts';
import { createWatcherListener } from '../cloud/watcher/watcher-listener.ts';
import { createGithubStorePoller } from '../server/github/github-store-poller.ts';
import { githubStoreProbes, watchProbeId } from '../server/github/github-store-probes.ts';
import { createGithubStoreWiring } from '../server/github/github-store-wiring.ts';
import { createPrGh } from '../server/github/pr-gh.ts';
import { githubApiOrigin, HEALTH_PATH, NUDGES_PATH, Probe as ProbeSchema, STATUS_PATH } from '../shared/contracts/watcher-link.ts';
import type { Nudge, Probe } from '../shared/contracts/watcher-link.ts';

const QUIET_LOG = { log: () => {}, warn: () => {} };
const LIGHT_PROBE: Probe = { id: 'github:light:0', laneId: 'test-lane', everyMs: 60_000, method: 'POST', url: 'https://api.github.com/graphql', body: '{"query":"query { viewer { login } }"}', credential: 'github' };

async function eventually<Value>(read: () => Value | undefined | Promise<Value | undefined>, timeoutMs = 10_000): Promise<Value> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition never held');
}

async function startLinkedWatcher(t: test.TestContext, probe: Probe = LIGHT_PROBE, { githubToken = 'read-token' as string | null, log = QUIET_LOG }: { githubToken?: string | null; log?: Pick<Console, 'log' | 'warn'> } = {}) {
  const watcherHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-watcher-link-'));
  const linkSecret = crypto.randomBytes(32);
  const clock = { nowMs: Date.now() };
  const now = () => clock.nowMs;
  const github = { body: '{"data":{"viewer":{"login":"first"}}}', status: 200, requests: [] as string[] };
  const githubFetch: typeof fetch = async (_input, init) => {
    github.requests.push(new Headers(init?.headers).get('authorization') ?? '');
    return new Response(github.body, { status: github.status, headers: { 'content-type': 'application/json' } });
  };
  const nudges: Nudge[] = [];
  const capturedEvents: { event: string; properties: unknown }[] = [];
  const coveredProbeCounts: number[] = [];
  const watcherProblems: (string | null)[] = [];
  const linkCredentials: { github: string | null } = { github: githubToken };
  const watcher: { runner: ReturnType<typeof createProbeRunner> | null; url: string | null; nudgeUrl: string | null } = { runner: null, url: null, nudgeUrl: null };
  let answerNudge: http.RequestListener = (_request, response) => response.writeHead(503).end();
  const nudgeListener = http.createServer((request, response) => answerNudge(request, response));
  await new Promise<void>((resolve) => nudgeListener.listen(0, '127.0.0.1', resolve));
  const nudgeAddress = nudgeListener.address();
  assert.ok(nudgeAddress !== null && typeof nudgeAddress === 'object');
  const serverUrl = `http://127.0.0.1:${nudgeAddress.port}`;
  const link = createWatcherLink({
    linkSecret,
    now,
    log,
    telemetry: { capture: (event, properties) => capturedEvents.push({ event, properties }) },
    credentials: () => ({ github: linkCredentials.github, posthog: { host: 'https://us.posthog.com', apiKey: 'posthog-read-key' } }),
    startWatcher: ({ onListening }) => {
      const home = createWatcherHome({ homeDir: watcherHome, credentialKey: credentialStoreKey(linkSecret), log: QUIET_LOG });
      const sender = createNudgeSender({ serverUrl, signingKey: directionKey(linkSecret, 'watcher-to-server'), now, log: QUIET_LOG });
      const runner = createProbeRunner({ home, nudges: sender, fetchFn: githubFetch, now, log: QUIET_LOG });
      const listener = createWatcherListener({ runner, signingKey: directionKey(linkSecret, 'server-to-watcher'), now, log: QUIET_LOG });
      watcher.runner = runner;
      watcher.nudgeUrl = serverUrl;
      t.after(async () => {
        runner.stop();
        sender.stop();
        await listener.close();
      });
      return {
        start: () => {
          void runner.start().then(() => listener.listen(0)).then((port) => {
            watcher.url = `http://127.0.0.1:${port}`;
            onListening(watcher.url);
          });
        },
        stop: () => {},
      };
    },
  });
  answerNudge = link.answerNudgeRequest;
  link.registerProbeSource({ laneId: 'test-lane', credential: 'github', probes: () => [probe], onNudge: (nudge) => nudges.push(nudge), onCoverageChange: (coveredProbes) => coveredProbeCounts.push(coveredProbes.length), onWatcherProblem: (problem) => watcherProblems.push(problem) });
  t.after(async () => {
    link.stop();
    await new Promise((resolve) => nudgeListener.close(resolve));
    await fsp.rm(watcherHome, { recursive: true, force: true });
  });
  await link.start();
  return { linkSecret, clock, github, nudges, coveredProbeCounts, watcherProblems, linkCredentials, link, watcher, capturedEvents };
}

test('a probe whose GitHub answer changes nudges its lane, and the lane hears the watcher covers that probe', async (t) => {
  const { clock, github, nudges, coveredProbeCounts, watcher } = await startLinkedWatcher(t);
  await eventually(() => coveredProbeCounts.at(-1) === 1 ? true : undefined);
  await eventually(() => github.requests.length >= 1 ? true : undefined);
  assert.deepEqual(github.requests, ['Bearer read-token']);
  assert.equal(nudges.length, 0);

  github.body = '{"data":{"viewer":{"login":"second"}}}';
  clock.nowMs += 61_000;
  await watcher.runner?.applyCredentials({ github: 'read-token', posthog: null });
  const nudge = await eventually(() => nudges[0]);
  assert.equal(nudge.probeId, LIGHT_PROBE.id);
  assert.equal(nudge.kind, 'changed');
});

test('a probe GitHub refuses by status or by a GraphQL error shows on its lane as a watcher problem, leaves watcher coverage until it recovers, and runs again at once on a new token', async (t) => {
  const { clock, github, nudges, coveredProbeCounts, watcherProblems, linkCredentials, link, watcher, capturedEvents } = await startLinkedWatcher(t);
  const runProbeAgain = async () => {
    const requestCount = github.requests.length;
    clock.nowMs += 61_000;
    await watcher.runner?.applyCredentials({ github: 'read-token', posthog: null });
    await eventually(() => github.requests.length > requestCount ? true : undefined);
  };
  await eventually(() => coveredProbeCounts.at(-1) === 1 ? true : undefined);
  await eventually(() => github.requests.length >= 1 ? true : undefined);

  github.status = 401;
  await runProbeAgain();
  await eventually(() => watcherProblems.at(-1) === 'Watcher cannot read GitHub: 401' ? true : undefined);
  assert.equal(coveredProbeCounts.at(-1), 0);
  assert.equal(nudges.length, 0);

  github.status = 200;
  github.body = '{"data":{"viewer":{"login":"back"}}}';
  await runProbeAgain();
  await eventually(() => watcherProblems.at(-1) === null && watcherProblems.length > 1 ? true : undefined);
  assert.equal(coveredProbeCounts.at(-1), 1);
  assert.equal((await eventually(() => nudges[0])).kind, 'recovered');
  assert.deepEqual(capturedEvents.map(({ event, properties }) => [event, properties]), [
    ['watcher_probe_failing', { lane: 'other', credential: 'github', failure_kind: 'unauthorized' }],
    ['watcher_probe_recovered', { lane: 'other', credential: 'github', failing_seconds: 61 }],
    ['watcher_nudge_received', { lane: 'other', kind: 'recovered' }],
  ]);

  github.body = '{"data":null,"errors":[{"type":"NOT_FOUND","message":"Could not resolve to a Repository"}]}';
  await runProbeAgain();
  await eventually(() => watcherProblems.at(-1) === 'Watcher cannot read GitHub: GraphQL error NOT_FOUND' ? true : undefined);
  assert.equal(coveredProbeCounts.at(-1), 0);

  github.body = '{"data":{"viewer":{"login":"granted"}}}';
  const requestCountBeforeNewToken = github.requests.length;
  await watcher.runner?.applyCredentials({ github: 'new-read-token', posthog: null });
  await eventually(() => github.requests.length > requestCountBeforeNewToken ? true : undefined);
  assert.equal(github.requests.at(-1), 'Bearer new-read-token');
  await eventually(() => watcherProblems.at(-1) === null ? true : undefined);
  assert.equal(coveredProbeCounts.at(-1), 1);

  github.status = 401;
  await runProbeAgain();
  await eventually(() => watcherProblems.at(-1) === 'Watcher cannot read GitHub: 401' ? true : undefined);
  linkCredentials.github = null;
  link.credentialsMayHaveChanged();
  await eventually(() => watcherProblems.at(-1) === null ? true : undefined);
});

test('with no GitHub read token the watcher runs no GitHub probe, the log says once why, and a token set later starts it', async (t) => {
  const logLines: string[] = [];
  const log = { log: (line: string) => logLines.push(line), warn: (line: string) => logLines.push(line) };
  const { github, linkCredentials, link, watcher, coveredProbeCounts } = await startLinkedWatcher(t, LIGHT_PROBE, { githubToken: null, log });
  await eventually(() => watcher.url ?? undefined);
  link.probesMayHaveChanged();
  await eventually(() => logLines.some((line) => line.includes('delivered probe set')) ? true : undefined);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(github.requests, []);
  assert.deepEqual(logLines.filter((line) => line.includes('no GitHub read token')), ['[watcher] no GitHub read token: test-lane polls on its own timer until one is set in Settings']);

  linkCredentials.github = 'read-token';
  link.credentialsMayHaveChanged();
  await eventually(() => coveredProbeCounts.at(-1) === 1 ? true : undefined);
  await eventually(() => github.requests.length >= 1 ? true : undefined);
  assert.deepEqual(github.requests, ['Bearer read-token']);
});

test('a GraphQL rate limit answered with 200 waits for its reset even when the same token is delivered again', async (t) => {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-watcher-runner-'));
  t.after(() => fsp.rm(homeDir, { recursive: true, force: true }));
  const clock = { nowMs: Date.now() };
  const sentTokens: string[] = [];
  const resetEpochSeconds = Math.ceil(clock.nowMs / 1000) + 3600;
  const fetchFn: typeof fetch = async (_input, init) => {
    sentTokens.push(new Headers(init?.headers).get('authorization') ?? '');
    return new Response('{"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}', { status: 200, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetEpochSeconds) } });
  };
  const runner = createProbeRunner({
    home: createWatcherHome({ homeDir, credentialKey: crypto.randomBytes(32), log: QUIET_LOG }),
    nudges: { send: () => {}, failingForMs: () => null },
    fetchFn,
    now: () => clock.nowMs,
    log: QUIET_LOG,
  });
  t.after(() => runner.stop());
  await runner.start();
  await runner.applyCredentials({ github: 'read-token', posthog: null });
  await runner.applyProbeSet({ revision: 'one-probe', probes: [LIGHT_PROBE] });
  await eventually(() => runner.status().probes[0]?.status === 'failing' ? true : undefined);

  clock.nowMs += 61_000;
  await runner.applyCredentials({ github: 'read-token', posthog: null });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(sentTokens.length, 1);
});

test('an answer to a request sent with the old token is dropped once a new token arrives', async (t) => {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-watcher-runner-'));
  t.after(() => fsp.rm(homeDir, { recursive: true, force: true }));
  const clock = { nowMs: Date.now() };
  const sentTokens: string[] = [];
  const heldAnswer: { release: (response: Response) => void } = { release: () => {} };
  const fetchFn: typeof fetch = async (_input, init) => {
    sentTokens.push(new Headers(init?.headers).get('authorization') ?? '');
    if (sentTokens.length !== 2) return new Response('{"data":{"viewer":{"login":"first"}}}', { status: 200 });
    return new Promise<Response>((resolve) => { heldAnswer.release = resolve; });
  };
  const nudgeKinds: string[] = [];
  const runner = createProbeRunner({
    home: createWatcherHome({ homeDir, credentialKey: crypto.randomBytes(32), log: QUIET_LOG }),
    nudges: { send: (kind) => { nudgeKinds.push(kind); }, failingForMs: () => null },
    fetchFn,
    now: () => clock.nowMs,
    log: QUIET_LOG,
  });
  t.after(() => runner.stop());
  await runner.start();
  await runner.applyCredentials({ github: 'old-read-token', posthog: null });
  await runner.applyProbeSet({ revision: 'one-probe', probes: [LIGHT_PROBE] });
  await eventually(() => runner.status().probes[0]?.status === 'ok' ? true : undefined);

  clock.nowMs += 61_000;
  await runner.applyCredentials({ github: 'old-read-token', posthog: null });
  await eventually(() => sentTokens.length === 2 ? true : undefined);
  await runner.applyCredentials({ github: 'new-read-token', posthog: null });
  heldAnswer.release(new Response('{"message":"Bad credentials"}', { status: 401 }));
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(runner.status().probes[0]?.status, 'ok');
  assert.deepEqual(nudgeKinds, []);
});

test('a probe naming an answer field nudges only when that field changes, never on per-run fields beside it', async (t) => {
  const posthogProbe: Probe = { id: 'radar:1', laneId: 'test-lane', everyMs: 60_000, method: 'POST', url: 'https://us.posthog.com/api/projects/1/query/', body: '{"query":{"kind":"HogQLQuery","query":"SELECT 1"}}', credential: 'posthog', answerField: 'results' };
  const { clock, github, nudges, coveredProbeCounts, watcher } = await startLinkedWatcher(t, posthogProbe);
  const runProbeAgain = async (body: string) => {
    const requestCount = github.requests.length;
    github.body = body;
    clock.nowMs += 61_000;
    await watcher.runner?.applyCredentials({ github: 'read-token', posthog: { host: 'https://us.posthog.com', apiKey: 'posthog-read-key' } });
    await eventually(() => github.requests.length > requestCount ? true : undefined);
  };
  await eventually(() => coveredProbeCounts.at(-1) === 1 ? true : undefined);
  await runProbeAgain('{"results":[["2026-11-07"]],"timings":[{"t":0.1}]}');
  await eventually(() => nudges.length === 1 ? true : undefined);
  nudges.length = 0;
  await runProbeAgain('{"results":[["2026-11-07"]],"timings":[{"t":0.2}]}');
  assert.equal(github.requests.at(-1), 'Bearer posthog-read-key');
  assert.equal(nudges.length, 0);

  await runProbeAgain('{"results":[["2026-11-08"]],"timings":[{"t":0.3}]}');
  const nudge = await eventually(() => nudges[0]);
  assert.equal(nudge.probeId, 'radar:1');
  assert.equal(nudge.kind, 'changed');
});

test('the server refuses a nudge that is forged, stale, replayed or signed with the other direction key, and the watcher health check needs no signature', async (t) => {
  const { linkSecret, clock, nudges, coveredProbeCounts, watcher } = await startLinkedWatcher(t);
  await eventually(() => coveredProbeCounts.at(-1) === 1 ? true : undefined);
  const nudgeUrl = new URL(NUDGES_PATH, watcher.nudgeUrl ?? '');
  const body = JSON.stringify({ nudgeId: crypto.randomUUID(), probeId: LIGHT_PROBE.id, kind: 'changed', failure: null, at: new Date(clock.nowMs).toISOString() });
  const post = (headers: Record<string, string>) => fetch(nudgeUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }).then((response) => response.status);
  const nudgeKey = directionKey(linkSecret, 'watcher-to-server');
  const validHeaders = signedHeaders(nudgeKey, { method: 'POST', path: NUDGES_PATH, body }, clock.nowMs);

  assert.equal(await post({ ...validHeaders, 'x-glimmervoid-signature': 'ab'.repeat(32) }), 401);
  assert.equal(await post(signedHeaders(nudgeKey, { method: 'POST', path: NUDGES_PATH, body }, clock.nowMs - 10 * 60_000)), 401);
  assert.equal(await post(signedHeaders(directionKey(linkSecret, 'server-to-watcher'), { method: 'POST', path: NUDGES_PATH, body }, clock.nowMs)), 401);
  assert.equal(await post(validHeaders), 200);
  assert.equal(await post(validHeaders), 401);
  assert.equal(nudges.length, 1);

  const health = await fetch(new URL(HEALTH_PATH, watcher.url ?? ''));
  assert.equal(health.status, 200);
});

test('a remote watcher links by URL and nudges its lane, and a watcher that stops answering or cannot nudge the server hands lanes back to their timers until it recovers', async (t) => {
  const watcherHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-remote-watcher-'));
  const linkSecret = crypto.randomBytes(32);
  const clock = { nowMs: Date.now() };
  const now = () => clock.nowMs;
  const github = { body: '{"data":{"viewer":{"login":"first"}}}', requestCount: 0 };
  const githubFetch: typeof fetch = async () => {
    github.requestCount += 1;
    return new Response(github.body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const nudges: Nudge[] = [];
  const coveredProbeCounts: number[] = [];
  const network = { isWatcherReachable: true, isDoormanForwarding: true, refusedNudgeCount: 0 };
  const partitionableFetch: typeof fetch = (input, init) => network.isWatcherReachable ? fetch(input, init) : Promise.reject(new TypeError('fetch failed'));

  let link: ReturnType<typeof createWatcherLink> | null = null;
  const serverListener = http.createServer((request, response) => {
    if (network.isDoormanForwarding) return link?.answerNudgeRequest(request, response);
    network.refusedNudgeCount += 1;
    response.writeHead(502).end();
  });
  await new Promise<void>((resolve) => serverListener.listen(0, '127.0.0.1', resolve));
  const serverAddress = serverListener.address();
  assert.ok(serverAddress !== null && typeof serverAddress === 'object');

  const home = createWatcherHome({ homeDir: watcherHome, credentialKey: credentialStoreKey(linkSecret), log: QUIET_LOG });
  const sender = createNudgeSender({ serverUrl: `http://127.0.0.1:${serverAddress.port}`, signingKey: directionKey(linkSecret, 'watcher-to-server'), now, log: QUIET_LOG });
  const runner = createProbeRunner({ home, nudges: sender, fetchFn: githubFetch, now, log: QUIET_LOG });
  const watcherListener = createWatcherListener({ runner, signingKey: directionKey(linkSecret, 'server-to-watcher'), now, log: QUIET_LOG });
  await runner.start();
  const watcherPort = await watcherListener.listen(0);

  link = createWatcherLink({
    linkSecret,
    now,
    log: QUIET_LOG,
    credentials: () => ({ github: 'read-token', posthog: null }),
    startWatcher: createRemoteWatcherStarter({ resolveWatcherUrl: async () => `http://127.0.0.1:${watcherPort}`, statusCheckMs: 50, fetchFn: partitionableFetch, now }),
  });
  link.registerProbeSource({ laneId: 'test-lane', credential: 'github', probes: () => [LIGHT_PROBE], onNudge: (nudge) => nudges.push(nudge), onCoverageChange: (coveredProbes) => coveredProbeCounts.push(coveredProbes.length), onWatcherProblem: () => {} });
  t.after(async () => {
    link?.stop();
    runner.stop();
    sender.stop();
    await watcherListener.close();
    await new Promise((resolve) => serverListener.close(resolve));
    await fsp.rm(watcherHome, { recursive: true, force: true });
  });
  await link.start();

  await eventually(() => coveredProbeCounts.at(-1) === 1 ? true : undefined);
  await eventually(() => github.requestCount >= 1 ? true : undefined);
  github.body = '{"data":{"viewer":{"login":"second"}}}';
  clock.nowMs += 61_000;
  await runner.applyCredentials({ github: 'read-token', posthog: null });
  const nudge = await eventually(() => nudges[0]);
  assert.equal(nudge.probeId, LIGHT_PROBE.id);

  network.isWatcherReachable = false;
  await eventually(() => coveredProbeCounts.at(-1) === 0 ? true : undefined);
  network.isWatcherReachable = true;
  await eventually(() => coveredProbeCounts.at(-1) === 1 ? true : undefined);

  network.isDoormanForwarding = false;
  github.body = '{"data":{"viewer":{"login":"third"}}}';
  clock.nowMs += 61_000;
  await runner.applyCredentials({ github: 'read-token', posthog: null });
  await eventually(() => network.refusedNudgeCount >= 1 ? true : undefined);
  clock.nowMs += 1_000;
  await eventually(() => coveredProbeCounts.at(-1) === 0 ? true : undefined);
  network.isDoormanForwarding = true;
  await eventually(() => coveredProbeCounts.at(-1) === 1 ? true : undefined, 20_000);
});

test('a timer tick still searches a watch the watcher does not cover yet, and leaves a covered, loaded watch to nudges', async () => {
  const searchedQualifiers: string[] = [];
  const unusedRead = async () => { throw new Error('not read in this test'); };
  const store = createGithubStorePoller({
    github: {
      searchPrsLight: async (qualifiers) => {
        searchedQualifiers.push(qualifiers);
        return { ok: true, items: [], isComplete: true, totalCount: 0, error: '' };
      },
      prsLightByKey: async () => ({ byKey: new Map(), goneKeys: new Set() }),
      prDetails: unusedRead, reviewThreadsBatch: unusedRead, viewPr: unusedRead, prDiff: unusedRead, prHead: unusedRead,
      behindCounts: async () => new Map(),
      notificationsSince: async () => ({ kind: 'unchanged' }),
      rateLimitWaitMs: async () => null,
    },
    now: Date.now,
    isDashboardConnected: () => true,
    exclusive: async (work) => work(),
    setTimeoutFn: setTimeout,
    clearTimeoutFn: clearTimeout,
    log: QUIET_LOG,
  });
  store.registerWatch({ name: 'covered', qualifiers: 'repo:a/b', needsDetail: false, intervalMs: 60_000 });
  await store.tick(['covered']);
  store.setCoveredProbes(githubStoreProbes(store.probeInputs()));
  store.registerWatch({ name: 'new', qualifiers: 'repo:c/d', needsDetail: false, intervalMs: 60_000 });
  searchedQualifiers.length = 0;
  await store.tick();
  assert.deepEqual(searchedQualifiers, ['repo:c/d']);
});

function storeWiringWithSearches(t: test.TestContext, searchAnswers: ('ok' | 'bad-gateway')[]) {
  const searchedQualifiers: string[] = [];
  const pendingTimers: (() => void)[] = [];
  const github = {
    ...createPrGh(os.tmpdir()),
    searchPrsLight: async (qualifiers: string) => {
      searchedQualifiers.push(qualifiers);
      const answer = searchAnswers.shift() ?? 'ok';
      if (answer === 'bad-gateway') return { ok: false as const, items: [], isComplete: false, error: 'HTTP 502 from GitHub' };
      return { ok: true as const, items: [], isComplete: true, totalCount: 0, error: '' };
    },
    prsLightByKey: async () => ({ byKey: new Map(), goneKeys: new Set<string>() }),
    rateLimitWaitMs: async () => null,
  };
  const wiring = createGithubStoreWiring({
    github,
    clock: { exclusive: async (work) => work(), schedule: () => () => {} },
    isDashboardConnected: () => true,
    broadcast: () => {},
    log: QUIET_LOG,
    setTimeoutFn: (run) => {
      pendingTimers.push(run);
      return { unref() {} } as NodeJS.Timeout;
    },
  });
  t.after(() => { pendingTimers.length = 0; });
  async function settle(): Promise<void> {
    for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  async function firePendingTimers(): Promise<number> {
    const timersToFire = pendingTimers.splice(0);
    for (const run of timersToFire) run();
    await settle();
    return timersToFire.length;
  }
  return { wiring, searchedQualifiers, settle, firePendingTimers };
}

test('a nudged store poll that fails runs again until it succeeds, then stops', async (t) => {
  const { wiring, searchedQualifiers, settle, firePendingTimers } = storeWiringWithSearches(t, ['bad-gateway', 'bad-gateway']);
  wiring.laneStore.registerWatch({ name: 'repo-watch', qualifiers: 'repo:a/b', needsDetail: false });
  wiring.probeSource.onNudge({ nudgeId: crypto.randomUUID(), probeId: watchProbeId('repo-watch'), kind: 'changed', failure: null, at: new Date().toISOString() });
  await settle();
  assert.equal(searchedQualifiers.length, 1);
  assert.equal(await firePendingTimers(), 1);
  assert.equal(searchedQualifiers.length, 2);
  assert.equal(await firePendingTimers(), 1);
  assert.equal(searchedQualifiers.length, 3);
  assert.equal(await firePendingTimers(), 0);
  assert.equal(wiring.getFreshness().error, null);
});

test('a probe the watcher newly covers gets one catch-up read, and the same coverage again gets none', async (t) => {
  const { wiring, searchedQualifiers, firePendingTimers } = storeWiringWithSearches(t, []);
  wiring.laneStore.registerWatch({ name: 'repo-watch', qualifiers: 'repo:a/b', needsDetail: false });
  const coveredProbes = wiring.probeSource.probes().filter((probe) => probe.id === watchProbeId('repo-watch'));
  assert.equal(coveredProbes.length, 1);
  wiring.probeSource.onCoverageChange(coveredProbes);
  assert.equal(await firePendingTimers(), 1);
  assert.deepEqual(searchedQualifiers, ['repo:a/b']);
  wiring.probeSource.onCoverageChange(coveredProbes);
  assert.equal(await firePendingTimers(), 0);
  assert.equal(searchedQualifiers.length, 1);
});

test('a GitHub API override moves probes only to a loopback address, and a plain http probe is refused anywhere else', () => {
  const overrides = ['http://127.0.0.1:4010', 'http://[::1]:4010', 'https://evil.example', 'http://127.0.0.1.evil.example', 'not a url', ''];
  assert.deepEqual(overrides.map((override) => githubApiOrigin({ GLIMMERVOID_GITHUB_API_BASE: override })), [
    'http://127.0.0.1:4010', 'http://[::1]:4010', 'https://api.github.com', 'https://api.github.com', 'https://api.github.com', 'https://api.github.com',
  ]);
  const probeUrls = ['http://127.0.0.1:4010/notifications', 'http://api.github.com/notifications', 'https://api.github.com/notifications', 'not a url', 'http://'];
  assert.deepEqual(probeUrls.map((url) => ProbeSchema.safeParse({ ...LIGHT_PROBE, url }).success), [true, false, true, false, false]);
});

async function listenOnLoopback(server: http.Server, port = 0): Promise<number> {
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return address.port;
}

function requestThroughDoorman(doormanPort: number, { host, path: requestPath, headers = {} }: { host: string; path: string; headers?: http.OutgoingHttpHeaders }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: doormanPort, path: requestPath, headers: { ...headers, host } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

async function doormanTenant(t: test.TestContext, slug: string, serverUrl: string) {
  const tenantHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-doorman-'));
  t.after(() => fsp.rm(tenantHome, { recursive: true, force: true }));
  const linkSecret = crypto.randomBytes(32);
  const linkSecretPath = path.join(tenantHome, 'watcher-link.key');
  await fsp.writeFile(linkSecretPath, `${linkSecret.toString('hex')}\n`, { mode: 0o600 });
  return { linkSecret, tenant: { slug, serverUrl, linkSecretPath, watcherHome: path.join(tenantHome, 'watcher') } };
}

test('a self-host doorman forwards pages and WebSockets with its own forwarding headers, serves its tenant watcher under the tenant key only, refuses outside nudges, and answers 502 at once when the server is down', async (t) => {
  const seenHeaders: http.IncomingHttpHeaders[] = [];
  const tenantServer = http.createServer((request, response) => {
    seenHeaders.push(request.headers);
    response.end('dashboard');
  });
  const echoSockets = new WebSocketServer({ server: tenantServer });
  echoSockets.on('connection', (socket) => socket.on('message', (message) => socket.send(`echo ${String(message)}`)));
  const serverPort = await listenOnLoopback(tenantServer);
  const { linkSecret, tenant } = await doormanTenant(t, 'selfhosttenant01', `http://127.0.0.1:${serverPort}`);
  const linkSecretText = await fsp.readFile(tenant.linkSecretPath, 'utf8');
  await fsp.rm(tenant.linkSecretPath);
  const doorman = createDoorman({ table: { tenantDomain: null, tenants: [tenant] }, log: QUIET_LOG });
  const doormanPort = await doorman.listen(0);
  assert.equal((await requestThroughDoorman(doormanPort, { host: `127.0.0.1:${doormanPort}`, path: HEALTH_PATH })).status, 503);
  await fsp.writeFile(tenant.linkSecretPath, linkSecretText, { mode: 0o600 });
  t.after(async () => {
    await doorman.close();
    echoSockets.close();
    tenantServer.closeAllConnections();
    await new Promise((resolve) => tenantServer.close(resolve));
  });

  const page = await requestThroughDoorman(doormanPort, { host: `127.0.0.1:${doormanPort}`, path: '/', headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9', 'tailscale-user-login': 'forged-owner@github' } });
  assert.deepEqual([page.status, page.body], [200, 'dashboard']);
  assert.equal(seenHeaders[0]['x-forwarded-proto'], 'http');
  assert.equal(seenHeaders[0]['x-forwarded-for'], undefined);
  assert.equal(seenHeaders[0]['tailscale-user-login'], undefined);

  const malformedAnswer = await new Promise<string>((resolve) => {
    const rawSocket = net.connect(doormanPort, '127.0.0.1', () => rawSocket.write('GET http://[ HTTP/1.1\r\nhost: localhost\r\n\r\n'));
    rawSocket.on('data', (chunk) => resolve(chunk.toString('utf8').split('\r\n')[0]));
  });
  assert.equal(malformedAnswer, 'HTTP/1.1 400 Bad Request');

  const socket = new WebSocket(`ws://127.0.0.1:${doormanPort}/terminals/one`);
  const echoed = await new Promise<string>((resolve, reject) => {
    socket.on('open', () => socket.send('hello'));
    socket.on('message', (message) => resolve(String(message)));
    socket.on('error', reject);
  });
  socket.close();
  assert.equal(echoed, 'echo hello');

  assert.equal((await requestThroughDoorman(doormanPort, { host: `127.0.0.1:${doormanPort}`, path: NUDGES_PATH })).status, 404);
  assert.equal((await requestThroughDoorman(doormanPort, { host: `127.0.0.1:${doormanPort}`, path: HEALTH_PATH })).status, 200);
  const signedStatus = (key: Buffer) => requestThroughDoorman(doormanPort, { host: `127.0.0.1:${doormanPort}`, path: STATUS_PATH, headers: signedHeaders(key, { method: 'GET', path: STATUS_PATH, body: '' }, Date.now()) });
  assert.equal((await signedStatus(directionKey(linkSecret, 'server-to-watcher'))).status, 200);
  assert.equal((await signedStatus(directionKey(crypto.randomBytes(32), 'server-to-watcher'))).status, 401);

  echoSockets.close();
  tenantServer.closeAllConnections();
  await new Promise((resolve) => tenantServer.close(resolve));
  assert.equal((await requestThroughDoorman(doormanPort, { host: `127.0.0.1:${doormanPort}`, path: '/' })).status, 502);
});

test('a hosted doorman refuses an unknown tenant host, passes the TLS edge headers, and wakes a sleeping tenant server once for every request held on it', async (t) => {
  const seenProtosByPath = new Map<string, string | string[] | undefined>();
  const sleepingServer = http.createServer((request, response) => {
    seenProtosByPath.set(request.url ?? '', request.headers['x-forwarded-proto']);
    response.end(`served ${request.url}`);
  });
  const sleepingPort = await listenOnLoopback(sleepingServer);
  await new Promise((resolve) => sleepingServer.close(resolve));
  const { tenant } = await doormanTenant(t, 'hostedtenant0001', `http://127.0.0.1:${sleepingPort}`);
  const wakeCalls: string[] = [];
  const hostAdapter = {
    wake: async (tenantSlug: string) => {
      wakeCalls.push(tenantSlug);
      await listenOnLoopback(sleepingServer, sleepingPort);
    },
  };
  const doorman = createDoorman({ table: { tenantDomain: 'tenants.example', tenants: [tenant] }, hostAdapter, tunables: { holdTimeoutMs: 5000, wakeCooldownMs: 30_000, maxHeldPerTenant: 8, readinessPollMs: 20 }, log: QUIET_LOG });
  const doormanPort = await doorman.listen(0);
  t.after(async () => {
    await doorman.close();
    sleepingServer.closeAllConnections();
    await new Promise((resolve) => sleepingServer.close(resolve));
  });

  assert.equal((await requestThroughDoorman(doormanPort, { host: 'someoneelse0001.tenants.example', path: '/' })).status, 421);
  assert.equal(wakeCalls.length, 0);

  const tenantHost = 'hostedtenant0001.tenants.example';
  const answers = await Promise.all(['/first', '/second', '/third'].map((requestPath) => requestThroughDoorman(doormanPort, { host: tenantHost, path: requestPath, headers: { 'x-forwarded-proto': 'https' } })));
  assert.deepEqual(answers.map((answer) => [answer.status, answer.body]), [[200, 'served /first'], [200, 'served /second'], [200, 'served /third']]);
  assert.deepEqual(wakeCalls, ['hostedtenant0001']);
  assert.deepEqual(['/first', '/second', '/third'].map((requestPath) => seenProtosByPath.get(requestPath)), ['https', 'https', 'https']);
});

test('a server starts one local doorman found by its port file, replaces it when Glimmervoid changes version, and the doorman stops once its tenant table is deleted', async (t) => {
  const glimmervoidHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-local-doorman-'));
  const stateDir = path.join(glimmervoidHome, 'doorman', '4999');
  const tablePath = path.join(stateDir, 'tenants.json');
  t.after(async () => {
    await fsp.rm(tablePath, { force: true });
    await eventually(async () => await localDoormanUrl(glimmervoidHome, 4999) === null ? true : undefined, 20_000).catch(() => {});
    await fsp.rm(glimmervoidHome, { recursive: true, force: true });
  });
  await fsp.mkdir(path.join(glimmervoidHome, 'watcher'));
  await fsp.writeFile(path.join(glimmervoidHome, 'watcher', 'probe-set.json'), '{}');
  const ensureAt = (version: string) => ensureDoorman({ glimmervoidHome, localPort: 4999, bindHost: '127.0.0.1', remoteListenerPort: 4998, version });
  const answeringUrl = async () => {
    const doormanUrl = await localDoormanUrl(glimmervoidHome, 4999);
    if (doormanUrl === null) return undefined;
    return fetch(new URL(HEALTH_PATH, doormanUrl)).then(() => doormanUrl, () => undefined);
  };
  const listeningLineCount = async () => (await fsp.readFile(path.join(stateDir, 'doorman.log'), 'utf8').catch(() => '')).split('\n').filter((line) => line.includes('[doorman] listening on')).length;

  await ensureAt('1.0.0');
  const firstUrl = await eventually(answeringUrl, 20_000);
  assert.equal(await fsp.readFile(path.join(stateDir, 'watcher', 'probe-set.json'), 'utf8'), '{}');
  assert.equal(JSON.parse(await fsp.readFile(tablePath, 'utf8')).tenants[0].serverUrl, 'http://127.0.0.1:4998');
  await ensureAt('1.0.0');
  assert.equal(await answeringUrl(), firstUrl);
  assert.equal(await listeningLineCount(), 1);

  await ensureAt('1.0.1');
  await eventually(async () => await listeningLineCount() === 2 && await answeringUrl() !== undefined ? true : undefined, 20_000);
  assert.match(await fsp.readFile(path.join(stateDir, 'doorman.log'), 'utf8'), /tenants\.json is gone, stopping/);

  await fsp.rm(tablePath);
  await eventually(async () => await localDoormanUrl(glimmervoidHome, 4999) === null ? true : undefined, 20_000);
});
