import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { credentialStoreKey, directionKey, signedHeaders } from '../cloud/link/core/link-signing-core.ts';
import { createWatcherLink } from '../cloud/link/watcher-link.ts';
import { createNudgeSender, createProbeRunner } from '../cloud/watcher/probe-runner.ts';
import { createWatcherHome } from '../cloud/watcher/watcher-home.ts';
import { createWatcherListener } from '../cloud/watcher/watcher-listener.ts';
import { createGithubStorePoller } from '../server/github/github-store-poller.ts';
import { githubStoreProbes, watchProbeId } from '../server/github/github-store-probes.ts';
import { createGithubStoreWiring } from '../server/github/github-store-wiring.ts';
import { createPrGh } from '../server/github/pr-gh.ts';
import { githubApiOrigin, HEALTH_PATH, NUDGES_PATH, Probe as ProbeSchema } from '../shared/contracts/watcher-link.ts';
import type { Nudge, Probe } from '../shared/contracts/watcher-link.ts';

const QUIET_LOG = { log: () => {}, warn: () => {} };
const LIGHT_PROBE: Probe = { id: 'github:light:0', laneId: 'test-lane', everyMs: 60_000, method: 'POST', url: 'https://api.github.com/graphql', body: '{"query":"query { viewer { login } }"}', credential: 'github' };

async function eventually<Value>(read: () => Value | undefined, timeoutMs = 10_000): Promise<Value> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
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
  const link = createWatcherLink({
    watcherHome,
    linkSecret,
    now,
    log,
    telemetry: { capture: (event, properties) => capturedEvents.push({ event, properties }) },
    credentials: () => ({ github: linkCredentials.github, posthog: { host: 'https://us.posthog.com', apiKey: 'posthog-read-key' } }),
    startWatcher: ({ serverUrl, onListening }) => {
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
  link.registerProbeSource({ laneId: 'test-lane', credential: 'github', probes: () => [probe], onNudge: (nudge) => nudges.push(nudge), onCoverageChange: (coveredProbes) => coveredProbeCounts.push(coveredProbes.length), onWatcherProblem: (problem) => watcherProblems.push(problem) });
  t.after(async () => {
    link.stop();
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
    nudges: { send: () => {} },
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
    nudges: { send: (kind) => { nudgeKinds.push(kind); } },
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
