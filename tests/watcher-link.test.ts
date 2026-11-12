import './helpers/isolate-home.ts';
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
import { createGcpHostAdapter } from '../cloud/doorman/gcp-host.ts';
import { ensureDoorman, localDoormanUrl } from '../cloud/doorman/ensure-doorman.ts';
import { loadOrCreateLinkSecret } from '../cloud/link/link-secret.ts';
import { createRemoteWatcherStarter } from '../cloud/link/remote-watcher-starter.ts';
import { createWatcherLink } from '../cloud/link/watcher-link.ts';
import { createNudgeSender, createProbeRunner } from '../cloud/watcher/probe-runner.ts';
import { createWatcherHome } from '../cloud/watcher/watcher-home.ts';
import { createWatcherListener } from '../cloud/watcher/watcher-listener.ts';
import { createGithubStorePoller } from '../server/github/github-store-poller.ts';
import { githubStoreProbes, watchProbeId } from '../server/github/github-store-probes.ts';
import { createGithubStoreWiring } from '../server/github/github-store-wiring.ts';
import { createPrGh } from '../server/github/pr-gh.ts';
import { startIdleStop } from '../server/idle-stop-wiring.ts';
import { laneAccessConfigOf } from '../server/lanes/core/lane-permissions-core.ts';
import { startAwakeUsageAlerts } from '../server/awake-usage-wiring.ts';
import { awakeUsageAlertText, newlyCrossedAlert, notifiedAfter } from '../server/core/awake-usage-core.ts';
import { STATES } from '../shared/states.ts';
import type { SessionState } from '../shared/states.ts';
import { AWAKE_USAGE_PATH, AwakeUsageAnswer, githubApiOrigin, HEALTH_PATH, HOST_STOP_PATH, NUDGES_PATH, Probe as ProbeSchema, STATUS_PATH } from '../shared/contracts/watcher-link.ts';
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

test('a server asks its doorman to stop its host once, after 20 awake minutes with no agent working, running background work or waiting on a wakeup, never counts suspended time, and reports the request with the background work left unfinished past its limit', async (t) => {
  const watcherHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-idle-stop-'));
  const linkSecret = crypto.randomBytes(32);
  const stopRequests: string[] = [];
  const home = createWatcherHome({ homeDir: watcherHome, credentialKey: credentialStoreKey(linkSecret), log: QUIET_LOG });
  const sender = createNudgeSender({ serverUrl: 'http://127.0.0.1:9', signingKey: directionKey(linkSecret, 'watcher-to-server'), log: QUIET_LOG });
  const runner = createProbeRunner({ home, nudges: sender, log: QUIET_LOG });
  const watcherListener = createWatcherListener({
    runner,
    signingKey: directionKey(linkSecret, 'server-to-watcher'),
    stopHost: async () => {
      stopRequests.push('stop');
      return 'stopping';
    },
    log: QUIET_LOG,
  });
  await runner.start();
  const watcherPort = await watcherListener.listen(0);
  const link = createWatcherLink({
    linkSecret,
    log: QUIET_LOG,
    credentials: () => ({ github: null, posthog: null }),
    startWatcher: createRemoteWatcherStarter({ resolveWatcherUrl: async () => `http://127.0.0.1:${watcherPort}`, statusCheckMs: 50 }),
  });
  t.after(async () => {
    link.stop();
    runner.stop();
    sender.stop();
    await watcherListener.close();
    await fsp.rm(watcherHome, { recursive: true, force: true });
  });
  await link.start();
  await eventually(async () => (await link.requestHostStop()) === 'stopping' ? true : undefined);
  stopRequests.length = 0;

  t.mock.timers.enable({ apis: ['setInterval'] });
  const clock = { nowMs: 0 };
  const noExpiredWork = { subagent: 0, shell: 0 };
  let liveSessions: { state: SessionState; hasBackgroundWork: boolean; expiredOpenWork: typeof noExpiredWork }[] = [];
  const stopReports: unknown[] = [];
  const idleStop = startIdleStop({
    liveSessions: () => liveSessions,
    requestHostStop: link.requestHostStop,
    reportStopRequested: (report) => stopReports.push(report),
    now: () => clock.nowMs,
    log: QUIET_LOG,
  });
  try {
    const passAwakeMinutes = (minutes: number) => {
      for (let quarter = 0; quarter < minutes * 4; quarter += 1) {
        clock.nowMs += 15_000;
        t.mock.timers.tick(15_000);
      }
    };

    liveSessions = [{ state: STATES.RUNNING, hasBackgroundWork: false, expiredOpenWork: noExpiredWork }, { state: STATES.IDLE, hasBackgroundWork: false, expiredOpenWork: noExpiredWork }];
    passAwakeMinutes(30);
    liveSessions = [{ state: STATES.IDLE, hasBackgroundWork: true, expiredOpenWork: noExpiredWork }];
    passAwakeMinutes(30);
    liveSessions = [{ state: STATES.STARTING, hasBackgroundWork: false, expiredOpenWork: noExpiredWork }];
    passAwakeMinutes(1);
    liveSessions = [
      { state: STATES.IDLE, hasBackgroundWork: false, expiredOpenWork: { subagent: 1, shell: 2 } },
      { state: STATES.IDLE, hasBackgroundWork: false, expiredOpenWork: noExpiredWork },
    ];
    passAwakeMinutes(19.75);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(stopRequests, []);

    passAwakeMinutes(0.25);
    await eventually(() => stopRequests.length === 1 ? true : undefined);
    clock.nowMs += 3 * 60 * 60_000;
    passAwakeMinutes(19.5);
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    idleStop.stop();
    t.mock.timers.reset();
  }
  assert.deepEqual(stopRequests, ['stop']);
  assert.deepEqual(stopReports, [{ outcome: 'stopping', sessions_with_expired_work: 1, expired_subagent_count: 1, expired_shell_count: 2 }]);
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

function requestThroughDoorman(doormanPort: number, { host, method = 'GET', path: requestPath, headers = {} }: { host: string; method?: string; path: string; headers?: http.OutgoingHttpHeaders }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port: doormanPort, method, path: requestPath, headers: { ...headers, host } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject).end();
  });
}

function requestHostStop(doormanPort: number, host: string, key: Buffer) {
  return requestThroughDoorman(doormanPort, { host, method: 'POST', path: HOST_STOP_PATH, headers: signedHeaders(key, { method: 'POST', path: HOST_STOP_PATH, body: '' }, Date.now()) });
}

const TEST_GCP_HOST = { kind: 'gcp', project: 'tenant-project', zone: 'us-central1-a', instance: 'tenant-vm' } as const;

async function doormanTenant(t: test.TestContext, slug: string, serverUrl: string) {
  const tenantHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-doorman-'));
  t.after(() => fsp.rm(tenantHome, { recursive: true, force: true }));
  const linkSecret = crypto.randomBytes(32);
  const linkSecretPath = path.join(tenantHome, 'watcher-link.key');
  await fsp.writeFile(linkSecretPath, `${linkSecret.toString('hex')}\n`, { mode: 0o600 });
  return { linkSecret, tenant: { slug, serverUrl, linkSecretPath, watcherHome: path.join(tenantHome, 'watcher'), awakeHoursPerMonth: null } };
}

test('a self-host doorman forwards pages and WebSockets with its own forwarding headers, serves its tenant watcher under the tenant key only, refuses outside nudges, answers a signed host stop that it has no adapter, and answers 502 at once when the server is down', async (t) => {
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
  const movedLinkSecret = loadOrCreateLinkSecret(path.join(path.dirname(tenant.linkSecretPath), 'secrets', 'watcher-link.key'), tenant.linkSecretPath);
  assert.deepEqual(movedLinkSecret, linkSecret, 'the server keeps its key when it moves it into the secrets folder');
  await fsp.writeFile(tenant.linkSecretPath, `${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
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
  const selfHostStop = await requestHostStop(doormanPort, `127.0.0.1:${doormanPort}`, directionKey(linkSecret, 'server-to-watcher'));
  assert.deepEqual([selfHostStop.status, JSON.parse(selfHostStop.body)], [200, { outcome: 'no-adapter' }]);

  echoSockets.close();
  tenantServer.closeAllConnections();
  await new Promise((resolve) => tenantServer.close(resolve));
  assert.equal((await requestThroughDoorman(doormanPort, { host: `127.0.0.1:${doormanPort}`, path: '/' })).status, 502);
});

test('a doorman with a WebSocket open through it finishes closing and ends that socket', async (t) => {
  const tenantServer = http.createServer((_request, response) => response.end('dashboard'));
  const echoSockets = new WebSocketServer({ server: tenantServer });
  echoSockets.on('connection', (socket) => socket.on('message', (message) => socket.send(`echo ${String(message)}`)));
  const serverPort = await listenOnLoopback(tenantServer);
  const { tenant } = await doormanTenant(t, 'selfhosttenant02', `http://127.0.0.1:${serverPort}`);
  const doorman = createDoorman({ table: { tenantDomain: null, tenants: [tenant] }, log: QUIET_LOG });
  const doormanPort = await doorman.listen(0);
  const socket = new WebSocket(`ws://127.0.0.1:${doormanPort}/terminals/one`);
  t.after(async () => {
    socket.terminate();
    for (const tenantSocket of echoSockets.clients) tenantSocket.terminate();
    echoSockets.close();
    tenantServer.closeAllConnections();
    await new Promise((resolve) => tenantServer.close(resolve));
  });
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => socket.send('hello'));
    socket.on('message', () => resolve());
    socket.on('error', reject);
  });
  const socketEnded = new Promise<string>((resolve) => socket.once('close', () => resolve('ended')));
  const closedInTime = new Promise<string>((resolve) => setTimeout(() => resolve('still open'), 1000));

  assert.equal(await Promise.race([doorman.close().then(() => 'closed'), closedInTime]), 'closed');
  assert.equal(await Promise.race([socketEnded, closedInTime]), 'ended');
});

test('a hosted doorman refuses an unknown tenant host, passes the TLS edge headers, wakes a sleeping tenant server once for every request held on it, and stops it only on a host stop signed with its key after its watcher started', async (t) => {
  const seenProtosByPath = new Map<string, string | string[] | undefined>();
  const sleepingServer = http.createServer((request, response) => {
    seenProtosByPath.set(request.url ?? '', request.headers['x-forwarded-proto']);
    response.end(`served ${request.url}`);
  });
  const sleepingPort = await listenOnLoopback(sleepingServer);
  await new Promise((resolve) => sleepingServer.close(resolve));
  const { linkSecret, tenant } = await doormanTenant(t, 'hostedtenant0001', `http://127.0.0.1:${sleepingPort}`);
  const wakeCalls: string[] = [];
  const stopCalls: string[] = [];
  const hostAdapter = {
    wake: async ({ slug }: { slug: string }) => {
      wakeCalls.push(slug);
      await listenOnLoopback(sleepingServer, sleepingPort);
    },
    stop: async ({ slug }: { slug: string }) => {
      stopCalls.push(slug);
    },
  };
  const doorman = createDoorman({ table: { tenantDomain: 'tenants.example', tenants: [{ ...tenant, host: TEST_GCP_HOST }] }, hostAdapter, tunables: { holdTimeoutMs: 5000, wakeCooldownMs: 30_000, maxHeldPerTenant: 8, readinessPollMs: 20, meterTickMs: 60_000, maxEdgeWakesPerHour: 4 }, log: QUIET_LOG });
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

  const serverKey = directionKey(linkSecret, 'server-to-watcher');
  assert.equal((await requestThroughDoorman(doormanPort, { host: tenantHost, method: 'POST', path: HOST_STOP_PATH })).status, 401);
  assert.equal((await requestHostStop(doormanPort, tenantHost, directionKey(crypto.randomBytes(32), 'server-to-watcher'))).status, 401);
  const signedBeforeWatcherStarted = signedHeaders(serverKey, { method: 'POST', path: HOST_STOP_PATH, body: '' }, Date.now() - 60_000);
  assert.equal((await requestThroughDoorman(doormanPort, { host: tenantHost, method: 'POST', path: HOST_STOP_PATH, headers: signedBeforeWatcherStarted })).status, 401);
  const replayedHeaders = signedHeaders(serverKey, { method: 'POST', path: HOST_STOP_PATH, body: '' }, Date.now());
  const accepted = await requestThroughDoorman(doormanPort, { host: tenantHost, method: 'POST', path: HOST_STOP_PATH, headers: replayedHeaders });
  assert.deepEqual([accepted.status, JSON.parse(accepted.body)], [202, { outcome: 'stopping' }]);
  assert.equal((await requestThroughDoorman(doormanPort, { host: tenantHost, method: 'POST', path: HOST_STOP_PATH, headers: replayedHeaders })).status, 401);
  assert.deepEqual(stopCalls, ['hostedtenant0001']);
});

test('a hosted doorman meters awake time in the tenant ledger, stops a host that reaches its monthly awake hours even when the first stop call hangs, and refuses to wake it again, even after a doorman restart, while its server notifies the operator once at 100 percent', async (t) => {
  const tenantServer = http.createServer((_request, response) => response.end('awake'));
  const tenantPort = await listenOnLoopback(tenantServer);
  await new Promise((resolve) => tenantServer.close(resolve));
  const { linkSecret, tenant } = await doormanTenant(t, 'cappedtenant0001', `http://127.0.0.1:${tenantPort}`);
  const cappedTenant = { ...tenant, awakeHoursPerMonth: 0.0001, host: TEST_GCP_HOST };
  const wakeCalls: string[] = [];
  const stopCalls: string[] = [];
  const hostAdapter = {
    wake: async ({ slug }: { slug: string }) => {
      wakeCalls.push(slug);
      await listenOnLoopback(tenantServer, tenantPort);
    },
    stop: async ({ slug }: { slug: string }) => {
      stopCalls.push(slug);
      if (stopCalls.length === 1) return new Promise<void>(() => {});
      tenantServer.closeAllConnections();
      await new Promise((resolve) => tenantServer.close(resolve));
    },
  };
  const tunables = { holdTimeoutMs: 5000, wakeCooldownMs: 0, maxHeldPerTenant: 8, readinessPollMs: 20, meterTickMs: 20, maxEdgeWakesPerHour: 4 };
  const table = { tenantDomain: 'tenants.example', tenants: [cappedTenant] };
  const tenantHost = 'cappedtenant0001.tenants.example';
  const firstDoorman = createDoorman({ table, hostAdapter, tunables, log: QUIET_LOG });
  const firstPort = await firstDoorman.listen(0);

  assert.deepEqual(await requestThroughDoorman(firstPort, { host: tenantHost, path: '/' }), { status: 200, body: 'awake' });
  await eventually(() => stopCalls.length === 2 ? true : undefined);
  await eventually(async () => (await fsp.readFile(path.join(tenant.watcherHome, 'awake-ledger.jsonl'), 'utf8').catch(() => '')).includes('slept') ? true : undefined);
  const refused = await requestThroughDoorman(firstPort, { host: tenantHost, path: '/' });
  assert.equal(refused.status, 503);
  assert.match(refused.body, /used its 0.0001 awake hours for this month/);
  assert.deepEqual(wakeCalls, ['cappedtenant0001']);
  await firstDoorman.close();

  const ledgerEvents = (await fsp.readFile(path.join(tenant.watcherHome, 'awake-ledger.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line).event);
  assert.deepEqual(ledgerEvents, ['woke', 'slept']);

  const restartedDoorman = createDoorman({ table, hostAdapter, tunables, log: QUIET_LOG });
  const restartedPort = await restartedDoorman.listen(0);
  t.after(() => restartedDoorman.close());
  assert.equal((await requestThroughDoorman(restartedPort, { host: tenantHost, path: '/' })).status, 503);
  assert.deepEqual(wakeCalls, ['cappedtenant0001']);

  const serverKey = directionKey(linkSecret, 'server-to-watcher');
  const readAwakeUsage = async () => {
    const answer = await requestThroughDoorman(restartedPort, { host: tenantHost, path: AWAKE_USAGE_PATH, headers: signedHeaders(serverKey, { method: 'GET', path: AWAKE_USAGE_PATH, body: '' }, Date.now()) });
    return AwakeUsageAnswer.parse(JSON.parse(answer.body)).awakeUsage;
  };
  const notifications: string[] = [];
  const statePath = path.join(path.dirname(tenant.watcherHome), 'awake-usage-alerts.json');
  for (let serverStart = 0; serverStart < 2; serverStart += 1) {
    const alerts = startAwakeUsageAlerts({ readAwakeUsage, notify: (_name, _category, message) => notifications.push(message), statePath, log: QUIET_LOG });
    await alerts.checked();
    alerts.stop();
  }
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /used all .* awake hours for this month/);
});

test('a hosted doorman answers a browser opening a sleeping tenant with a waking page at once, counts only wakes that started the host, and past the edge wake limit leaves the host asleep with a Retry-After an hour out', async (t) => {
  const tenantServer = http.createServer((_request, response) => response.end('awake'));
  const tenantPort = await listenOnLoopback(tenantServer);
  await new Promise((resolve) => tenantServer.close(resolve));
  const { linkSecret, tenant } = await doormanTenant(t, 'limitedtenant001', `http://127.0.0.1:${tenantPort}`);
  const wakeCalls: string[] = [];
  const hostAdapter = {
    wake: async ({ slug }: { slug: string }) => {
      wakeCalls.push(slug);
      if (wakeCalls.length === 1) throw new Error('ZONE_RESOURCE_POOL_EXHAUSTED');
      await listenOnLoopback(tenantServer, tenantPort);
    },
    stop: async () => {
      tenantServer.closeAllConnections();
      await new Promise((resolve) => tenantServer.close(resolve));
    },
  };
  const tunables = { holdTimeoutMs: 300, wakeCooldownMs: 0, maxHeldPerTenant: 8, readinessPollMs: 20, meterTickMs: 60_000, maxEdgeWakesPerHour: 1 };
  const doorman = createDoorman({ table: { tenantDomain: 'tenants.example', tenants: [{ ...tenant, host: TEST_GCP_HOST }] }, hostAdapter, tunables, log: QUIET_LOG });
  const doormanPort = await doorman.listen(0);
  t.after(async () => {
    await doorman.close();
    tenantServer.closeAllConnections();
    await new Promise((resolve) => tenantServer.close(resolve));
  });
  const tenantHost = 'limitedtenant001.tenants.example';
  const browserHeaders = { accept: 'text/html,application/xhtml+xml' };

  const wakingPage = await requestThroughDoorman(doormanPort, { host: tenantHost, path: '/', headers: browserHeaders });
  assert.equal(wakingPage.status, 503);
  assert.match(wakingPage.body, /Waking your Glimmervoid/);
  assert.match(wakingPage.body, /http-equiv="refresh"/);
  await eventually(() => wakeCalls.length === 1 ? true : undefined);
  assert.deepEqual(await eventually(async () => {
    const answer = await requestThroughDoorman(doormanPort, { host: tenantHost, path: '/', headers: browserHeaders });
    return answer.status === 200 ? answer : undefined;
  }), { status: 200, body: 'awake' });

  const stopped = await requestHostStop(doormanPort, tenantHost, directionKey(linkSecret, 'server-to-watcher'));
  assert.equal(stopped.status, 202);
  await eventually(async () => (await fsp.readFile(path.join(tenant.watcherHome, 'awake-ledger.jsonl'), 'utf8').catch(() => '')).includes('slept') ? true : undefined);

  const limited = await requestThroughDoorman(doormanPort, { host: tenantHost, path: '/api/state' });
  assert.equal(limited.status, 503);
  const limitedPage = await requestThroughDoorman(doormanPort, { host: tenantHost, path: '/', headers: browserHeaders });
  assert.match(limitedPage.body, /Woken too often this hour/);
  assert.doesNotMatch(limitedPage.body, /http-equiv="refresh"/);
  assert.deepEqual(wakeCalls, ['limitedtenant001', 'limitedtenant001']);
});

test('the GCE host adapter resumes a suspended instance, starts a terminated one, waits out a suspend in progress and a passing 503, suspends only a running one, refuses to call an instance in repair stopped, and fails on a refused call', async () => {
  const instanceUrl = 'https://compute.googleapis.com/compute/v1/projects/tenant-project/zones/us-central1-a/instances/tenant-vm';
  const statusReads: string[] = [];
  const calls: string[] = [];
  let refusesWith: number | null = null;
  const fakeGoogle: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('http://metadata.google.internal/')) return Response.json({ access_token: 'metadata-token', expires_in: 3599 });
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer metadata-token');
    if (refusesWith !== null) return new Response('denied', { status: refusesWith });
    if (url === instanceUrl) {
      const status = statusReads.shift() ?? 'RUNNING';
      return status === 'BUSY' ? new Response('backend error', { status: 503 }) : Response.json({ status });
    }
    calls.push(`${init?.method} ${url.slice(instanceUrl.length)}`);
    return Response.json({ kind: 'compute#operation' });
  };
  const adapter = createGcpHostAdapter({ fetchFn: fakeGoogle, settleTimeoutMs: 1000, settlePollMs: 1 });
  const tenant = { slug: 'gcptenant0001', serverUrl: 'http://10.0.0.2:8080', linkSecretPath: '/unused', watcherHome: '/unused', githubInstallation: null, awakeHoursPerMonth: null, host: TEST_GCP_HOST };

  statusReads.push('SUSPENDED');
  await adapter.wake(tenant);
  statusReads.push('TERMINATED');
  await adapter.wake(tenant);
  statusReads.push('SUSPENDING', 'SUSPENDING', 'SUSPENDED');
  await adapter.wake(tenant);
  statusReads.push('SUSPENDING', 'BUSY', 'SUSPENDED');
  await adapter.wake(tenant);
  statusReads.push('RUNNING');
  await adapter.wake(tenant);
  statusReads.push('REPAIRING');
  await assert.rejects(adapter.stop(tenant), /REPAIRING, so it was not suspended/);
  statusReads.push('SUSPENDED');
  await adapter.stop(tenant);
  statusReads.push('RUNNING');
  await adapter.stop(tenant);
  assert.deepEqual(calls, ['POST /resume', 'POST /start', 'POST /resume', 'POST /resume', 'POST /suspend']);

  refusesWith = 403;
  await assert.rejects(adapter.wake(tenant), /answered 403/);
});

test('a server sends the 100 percent awake-hours alert while the cap is still within its lookahead, and alerts again when the cap changes mid-month', () => {
  const hour = 3_600_000;
  const usageAt = (usedMs: number, capMs: number) => ({ usedMs, capMs, periodStartAt: '2026-11-01T00:00:00.000Z', periodEndsAt: '2026-12-01T00:00:00.000Z' });
  const lookaheadMs = 30 * 60_000;
  const nearCap = newlyCrossedAlert(usageAt(10 * hour - 20 * 60_000, 10 * hour), null, lookaheadMs);
  assert.ok(nearCap !== null);
  assert.equal(nearCap.threshold, 100);
  assert.match(awakeUsageAlertText(nearCap), /within 20 awake minutes/);
  const notified = notifiedAfter(usageAt(10 * hour, 10 * hour), nearCap);
  assert.equal(newlyCrossedAlert(usageAt(10 * hour, 10 * hour), notified, lookaheadMs), null);
  assert.equal(newlyCrossedAlert(usageAt(31 * hour, 40 * hour), notified, lookaheadMs)?.threshold, 75);
});

test('a server starts one local doorman found by its port file, replaces it when Glimmervoid changes version, and the doorman stops once its whole home is deleted', async (t) => {
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
  const replacementUrl = await eventually(async () => await listeningLineCount() === 2 ? answeringUrl() : undefined, 20_000);
  assert.match(await fsp.readFile(path.join(stateDir, 'doorman.log'), 'utf8'), /tenants\.json is gone, stopping/);

  await fsp.rm(glimmervoidHome, { recursive: true, force: true });
  await eventually(async () => fetch(new URL(HEALTH_PATH, replacementUrl)).then(() => undefined, () => true), 20_000);
});

function fakeGithubApp(clock: { nowMs: number }, tokenLifetimesMs: number[]) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const secretName = 'projects/glimmervoid-test/secrets/github-app-private-key';
  const mints: { claims: { iat: number; exp: number; iss: string }; body: { repositories?: string[]; permissions: Record<string, string> }; atMs: number }[] = [];
  const secretReads: string[] = [];
  const appFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url.startsWith('http://metadata.google.internal/')) {
      assert.equal(headers.get('metadata-flavor'), 'Google');
      return Response.json({ access_token: 'metadata-token', expires_in: 3599 });
    }
    if (url.startsWith('https://secretmanager.googleapis.com/')) {
      assert.equal(headers.get('authorization'), 'Bearer metadata-token');
      secretReads.push(url);
      return Response.json({ name: `${secretName}/versions/3`, payload: { data: Buffer.from(privateKeyPem).toString('base64') } });
    }
    assert.equal(url, 'https://api.github.com/app/installations/4242/access_tokens');
    const [header, payload, signature] = (headers.get('authorization') ?? '').replace('Bearer ', '').split('.');
    assert.ok(crypto.verify('sha256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')), 'the JWT is signed with the App key');
    mints.push({ claims: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), body: JSON.parse(String(init?.body)), atMs: clock.nowMs });
    const lifetimeMs = tokenLifetimesMs[mints.length - 1] ?? 60 * 60_000;
    return Response.json({ token: `ghs_minted${mints.length}`, expires_at: new Date(clock.nowMs + lifetimeMs).toISOString() }, { status: 201 });
  };
  return { appFetch, mints, secretReads, githubApp: { clientId: 'Iv23liTestClient', privateKeySecret: secretName } };
}

test('a doorman with a GitHub App mints a read-only installation token for its tenant watcher, probes with it while the server sends no read token, re-mints before the hour ends, hands the awake server that token over the signed link, and leaves an operator read token in charge', async (t) => {
  const clock = { nowMs: Date.now() };
  const app = fakeGithubApp(clock, [10 * 60_000 + 200]);
  const { linkSecret, tenant } = await doormanTenant(t, 'apptenant000001', 'http://127.0.0.1:9');
  const probeAuthorizations: string[] = [];
  const probeFetch: typeof fetch = async (_input, init) => {
    probeAuthorizations.push(new Headers(init?.headers).get('authorization') ?? '');
    return Response.json({ data: { viewer: { login: 'tenant' } } });
  };
  const doorman = createDoorman({
    table: { tenantDomain: null, githubApp: app.githubApp, tenants: [{ ...tenant, githubInstallation: { installationId: 4242, repositories: ['glimmervoid', 'site'] } }] },
    probeFetch, githubAppFetch: app.appFetch, now: () => clock.nowMs, log: QUIET_LOG,
  });
  const doormanPort = await doorman.listen(0);
  const linkCredentials: { github: string | null } = { github: null };
  const coveredProbeCounts: number[] = [];
  let githubAppTokenChanges = 0;
  const link = createWatcherLink({
    linkSecret, now: () => clock.nowMs, log: QUIET_LOG,
    credentials: () => ({ github: linkCredentials.github, posthog: null }),
    startWatcher: createRemoteWatcherStarter({ resolveWatcherUrl: async () => `http://127.0.0.1:${doormanPort}`, statusCheckMs: 50 }),
    onGithubAppTokenChange: () => { githubAppTokenChanges += 1; },
  });
  link.registerProbeSource({ laneId: 'test-lane', credential: 'github', probes: () => [LIGHT_PROBE], onNudge: () => {}, onCoverageChange: (coveredProbes) => coveredProbeCounts.push(coveredProbes.length), onWatcherProblem: () => {} });
  t.after(async () => {
    link.stop();
    await doorman.close();
  });
  await link.start();

  await eventually(() => (coveredProbeCounts.at(-1) === 1 && link.githubAppToken() !== null ? true : undefined));
  const serverToken = link.githubAppToken();
  assert.match(serverToken ?? '', /^ghs_minted[23]$/, 'the server gets a fresh mint, never the token with ten minutes left');
  assert.equal(githubAppTokenChanges, 1);
  assert.equal(laneAccessConfigOf({}, serverToken).readToken, serverToken, 'lanes read GitHub with the App token when no read token is set');
  assert.match(probeAuthorizations[0] ?? '', /^Bearer ghs_minted\d$/, 'the first probe already carries a minted token');

  await eventually(() => (app.mints.length >= 2 ? true : undefined));

  assert.deepEqual(app.mints[0].body, { repositories: ['glimmervoid', 'site'], permissions: { actions: 'read', checks: 'read', contents: 'read', issues: 'read', metadata: 'read', pull_requests: 'read', statuses: 'read' } });
  for (const mint of app.mints) {
    assert.equal(mint.claims.iss, 'Iv23liTestClient');
    assert.ok(mint.claims.iat <= Math.floor(mint.atMs / 1000) - 60 && mint.claims.exp - mint.claims.iat <= 600, 'the JWT is backdated a minute and lives at most ten');
  }
  assert.deepEqual(app.secretReads, ['https://secretmanager.googleapis.com/v1/projects/glimmervoid-test/secrets/github-app-private-key/versions/current:access'], 'the key is read once and kept for ten minutes');

  clock.nowMs += 61_000;
  linkCredentials.github = 'operator-read-token';
  link.credentialsMayHaveChanged();
  await eventually(() => (probeAuthorizations.at(-1) === 'Bearer operator-read-token' ? true : undefined));
  assert.equal(laneAccessConfigOf({ github: { readToken: 'operator-read-token' } }, link.githubAppToken()).readToken, 'operator-read-token');
});
