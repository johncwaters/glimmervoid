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
import { createGithubUserLink } from '../cloud/doorman/github-user.ts';
import { createFileTenantRecordStore } from '../cloud/doorman/tenant-record-store.ts';
import { ensureDoorman, localDoormanUrl } from '../cloud/doorman/ensure-doorman.ts';
import { loadOrCreateLinkSecret } from '../cloud/link/link-secret.ts';
import { createRemoteWatcherStarter } from '../cloud/link/remote-watcher-starter.ts';
import { createWatcherLink } from '../cloud/link/watcher-link.ts';
import { createNudgeSender, createProbeRunner } from '../cloud/watcher/probe-runner.ts';
import { createWatcherHome, watcherFilesInFolder } from '../cloud/watcher/watcher-home.ts';
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
import { AWAKE_USAGE_PATH, AwakeUsageAnswer, GITHUB_CONNECT_PATH, GITHUB_CONNECTION_PATH, GITHUB_TOKEN_PATH, GithubConnectionAnswer, GithubTokenAnswer, githubApiOrigin, HEALTH_PATH, HOST_STOP_PATH, NUDGES_PATH, Probe as ProbeSchema, STATUS_PATH } from '../shared/contracts/watcher-link.ts';
import type { GithubConnection, Nudge, Probe } from '../shared/contracts/watcher-link.ts';

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
      const home = createWatcherHome({ files: watcherFilesInFolder(watcherHome), credentialKey: credentialStoreKey(linkSecret), log: QUIET_LOG });
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
        checkNow: () => {},
      };
    },
  });
  const refusedNudges = { remaining: 0 };
  answerNudge = (request, response) => {
    if (refusedNudges.remaining === 0) return link.answerNudgeRequest(request, response);
    refusedNudges.remaining -= 1;
    response.writeHead(503).end();
  };
  link.registerProbeSource({ laneId: 'test-lane', credential: 'github', probes: () => [probe], onNudge: (nudge) => nudges.push(nudge), onCoverageChange: (coveredProbes) => coveredProbeCounts.push(coveredProbes.length), onWatcherProblem: (problem) => watcherProblems.push(problem) });
  t.after(async () => {
    link.stop();
    await new Promise((resolve) => nudgeListener.close(resolve));
    await fsp.rm(watcherHome, { recursive: true, force: true });
  });
  await link.start();
  return { linkSecret, clock, github, nudges, coveredProbeCounts, watcherProblems, linkCredentials, link, watcher, capturedEvents, refusedNudges };
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

test('a pending wake reaches the watcher as an alarm and comes back once at its time as an alarm nudge, sent again while the server refuses it', async (t) => {
  const { clock, link, watcher, refusedNudges } = await startLinkedWatcher(t);
  const alarmNudges: string[] = [];
  const alarm = { id: 'wake:w1', at: new Date(clock.nowMs + 10 * 60_000).toISOString() };
  link.registerAlarmSource({ alarms: () => [alarm], onAlarm: (alarmId) => alarmNudges.push(alarmId) });
  await eventually(() => watcher.runner?.status().probeSetRevision?.length ? true : undefined);
  await watcher.runner?.applyCredentials({ github: 'read-token', posthog: null });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(alarmNudges, []);

  refusedNudges.remaining = 1;
  clock.nowMs += 10 * 60_000;
  await watcher.runner?.applyCredentials({ github: 'read-token', posthog: null });
  await eventually(() => alarmNudges.length > 0 ? true : undefined);
  await watcher.runner?.applyCredentials({ github: 'read-token', posthog: null });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(refusedNudges.remaining, 0);
  assert.deepEqual(alarmNudges, [alarm.id]);
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

test('a GraphQL rate limit answered with 200 waits for its reset even when the same token is delivered again or the probe request changes', async (t) => {
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
    home: createWatcherHome({ files: watcherFilesInFolder(homeDir), credentialKey: crypto.randomBytes(32), log: QUIET_LOG }),
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

  await runner.applyProbeSet({ revision: 'changed-request', probes: [{ ...LIGHT_PROBE, body: '{"query":"query { viewer { id } }"}' }] });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sentTokens.length, 1);

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
    home: createWatcherHome({ files: watcherFilesInFolder(homeDir), credentialKey: crypto.randomBytes(32), log: QUIET_LOG }),
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

test('a server asks its doorman to stop its host once, after 20 awake minutes with no agent working, running background work, waiting on a wakeup or a wake due inside those minutes, never counts suspended time, and reports the request with the background work left unfinished past its limit', async (t) => {
  const watcherHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-idle-stop-'));
  const linkSecret = crypto.randomBytes(32);
  const stopRequests: string[] = [];
  const home = createWatcherHome({ files: watcherFilesInFolder(watcherHome), credentialKey: credentialStoreKey(linkSecret), log: QUIET_LOG });
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
  let nextWakeAt: number | null = null;
  const idleStop = startIdleStop({
    liveSessions: () => liveSessions,
    requestHostStop: link.requestHostStop,
    reportStopRequested: (report) => stopReports.push(report),
    nextWakeAt: () => nextWakeAt,
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
    liveSessions = [{ state: STATES.IDLE, hasBackgroundWork: false, expiredOpenWork: noExpiredWork }];
    nextWakeAt = clock.nowMs + 25 * 60_000;
    passAwakeMinutes(24);
    nextWakeAt = null;
    liveSessions = [{ state: STATES.STARTING, hasBackgroundWork: false, expiredOpenWork: noExpiredWork }];
    passAwakeMinutes(1);
    liveSessions = [
      { state: STATES.IDLE, hasBackgroundWork: false, expiredOpenWork: { subagent: 1, shell: 2 } },
      { state: STATES.IDLE, hasBackgroundWork: false, expiredOpenWork: noExpiredWork },
    ];
    nextWakeAt = clock.nowMs + 3 * 60 * 60_000;
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

test('a server that wakes from a sleep longer than 30 s rechecks its remote watcher at once instead of waiting out the status timer, and a steady tick never does', async (t) => {
  const watcherHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-host-wake-'));
  const linkSecret = crypto.randomBytes(32);
  const home = createWatcherHome({ files: watcherFilesInFolder(watcherHome), credentialKey: credentialStoreKey(linkSecret), log: QUIET_LOG });
  const sender = createNudgeSender({ serverUrl: 'http://127.0.0.1:9', signingKey: directionKey(linkSecret, 'watcher-to-server'), log: QUIET_LOG });
  const runner = createProbeRunner({ home, nudges: sender, log: QUIET_LOG });
  const watcherListener = createWatcherListener({ runner, signingKey: directionKey(linkSecret, 'server-to-watcher'), log: QUIET_LOG });
  await runner.start();
  const watcherPort = await watcherListener.listen(0);
  let statusCheckCount = 0;
  const countingFetch: typeof fetch = (input, init) => {
    if (String(input).endsWith(STATUS_PATH)) statusCheckCount += 1;
    return fetch(input, init);
  };
  const link = createWatcherLink({
    linkSecret,
    log: QUIET_LOG,
    credentials: () => ({ github: null, posthog: null }),
    startWatcher: createRemoteWatcherStarter({ resolveWatcherUrl: async () => `http://127.0.0.1:${watcherPort}`, fetchFn: countingFetch }),
  });
  t.after(async () => {
    link.stop();
    runner.stop();
    sender.stop();
    await watcherListener.close();
    await fsp.rm(watcherHome, { recursive: true, force: true });
  });
  await link.start();
  await eventually(() => statusCheckCount === 1 ? true : undefined);

  t.mock.timers.enable({ apis: ['setInterval'] });
  const clock = { nowMs: 0 };
  const sleptReports: number[] = [];
  const idleStop = startIdleStop({
    liveSessions: () => [],
    requestHostStop: link.requestHostStop,
    reportStopRequested: () => {},
    onHostWoke: (sleptMs) => {
      sleptReports.push(sleptMs);
      link.hostWoke();
    },
    now: () => clock.nowMs,
    log: QUIET_LOG,
  });
  try {
    for (let tick = 0; tick < 8; tick += 1) {
      clock.nowMs += 15_000;
      t.mock.timers.tick(15_000);
    }
    clock.nowMs += 15_000 + 29_000;
    t.mock.timers.tick(15_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(sleptReports, []);
    assert.equal(statusCheckCount, 1);

    clock.nowMs += 15_000 + 3 * 60 * 60_000;
    t.mock.timers.tick(15_000);
    await eventually(() => statusCheckCount === 2 ? true : undefined);
  } finally {
    idleStop.stop();
    t.mock.timers.reset();
  }
  assert.deepEqual(sleptReports, [3 * 60 * 60_000]);
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

  const home = createWatcherHome({ files: watcherFilesInFolder(watcherHome), credentialKey: credentialStoreKey(linkSecret), log: QUIET_LOG });
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

test('a PR read once on request stays out of the probe set', async () => {
  const unusedRead = async () => { throw new Error('not read in this test'); };
  const refreshTimers: (() => void)[] = [];
  const detailReads: string[] = [];
  const refreshedNode = { repository: { nameWithOwner: 'a/b' }, number: 7, updatedAt: '2026-11-12T00:00:00Z', headRefOid: 'abc', state: 'OPEN' as const, commits: { nodes: [] }, reviewDecision: null, mergeable: 'MERGEABLE' as const };
  const store = createGithubStorePoller({
    github: {
      searchPrsLight: async () => ({ ok: true, items: [], isComplete: true, totalCount: 0, error: '' }),
      prsLightByKey: async () => ({ byKey: new Map([['a/b#7', refreshedNode]]), goneKeys: new Set() }),
      prDetails: async () => {
        detailReads.push('a/b#7');
        return { byKey: new Map(), goneKeys: new Set(['a/b#7']) };
      },
      reviewThreadsBatch: unusedRead, viewPr: unusedRead, prDiff: unusedRead, prHead: unusedRead,
      behindCounts: async () => new Map(),
      notificationsSince: async () => ({ kind: 'unchanged' }),
      rateLimitWaitMs: async () => null,
    },
    now: Date.now,
    isDashboardConnected: () => true,
    exclusive: async (work) => work(),
    setTimeoutFn: (run) => {
      refreshTimers.push(run);
      return { unref() {} } as NodeJS.Timeout;
    },
    clearTimeoutFn: () => {},
    log: QUIET_LOG,
  });
  store.requestRefresh('a/b#7');
  for (const run of refreshTimers.splice(0)) run();
  await eventually(() => detailReads.length === 1 ? true : undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(store.probeInputs().knownPrs, []);
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
  return { linkSecret, linkSecretPath, tenant: { slug, serverUrl, linkSecret: { kind: 'file', path: linkSecretPath } as const, watcherHome: path.join(tenantHome, 'watcher'), awakeHoursPerMonth: null } };
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
  const { linkSecret, linkSecretPath, tenant } = await doormanTenant(t, 'selfhosttenant01', `http://127.0.0.1:${serverPort}`);
  const linkSecretText = await fsp.readFile(linkSecretPath, 'utf8');
  await fsp.rm(linkSecretPath);
  const doorman = createDoorman({ table: { tenantDomain: null, tenants: [tenant] }, log: QUIET_LOG });
  const doormanPort = await doorman.listen(0);
  assert.equal((await requestThroughDoorman(doormanPort, { host: `127.0.0.1:${doormanPort}`, path: HEALTH_PATH })).status, 503);
  await fsp.writeFile(linkSecretPath, linkSecretText, { mode: 0o600 });
  const movedLinkSecret = loadOrCreateLinkSecret(path.join(path.dirname(linkSecretPath), 'secrets', 'watcher-link.key'), linkSecretPath);
  assert.deepEqual(movedLinkSecret, linkSecret, 'the server keeps its key when it moves it into the secrets folder');
  await fsp.writeFile(linkSecretPath, `${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
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

test('a hosted doorman answers a browser opening a sleeping tenant with a waking page at once, counts only wakes that started the host, and past the edge wake limit leaves the host asleep with a Retry-After an hour out, even after a doorman restart', async (t) => {
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

  const restartedDoorman = createDoorman({ table: { tenantDomain: 'tenants.example', tenants: [{ ...tenant, host: TEST_GCP_HOST }] }, hostAdapter, tunables, log: QUIET_LOG });
  const restartedPort = await restartedDoorman.listen(0);
  t.after(() => restartedDoorman.close());
  assert.match((await requestThroughDoorman(restartedPort, { host: tenantHost, path: '/', headers: browserHeaders })).body, /Woken too often this hour/);
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
  const tenant = { slug: 'gcptenant0001', serverUrl: 'http://10.0.0.2:8080', linkSecret: { kind: 'file', path: '/unused' } as const, watcherHome: '/unused', awakeHoursPerMonth: null, host: TEST_GCP_HOST };

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
  const user = { isAuthorized: false, issued: 0, liveAccessTokens: new Set<string>(), liveRefreshToken: null as string | null, refreshesWith: [] as string[], deviceFlowEnabled: true, userReads: 0, userReadGate: null as Promise<void> | null };
  function issueUserTokens() {
    user.issued += 1;
    const accessToken = `ghu_user${user.issued}`;
    user.liveAccessTokens = new Set([accessToken]);
    user.liveRefreshToken = `ghr_user${user.issued}`;
    return Response.json({ access_token: accessToken, expires_in: 28_800, refresh_token: user.liveRefreshToken, refresh_token_expires_in: 15_897_600, token_type: 'bearer' });
  }
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
    if (url === 'https://github.com/login/device/code') {
      assert.equal(new URLSearchParams(String(init?.body)).get('client_id'), 'Iv23liTestClient');
      if (!user.deviceFlowEnabled) return Response.json({ error: 'device_flow_disabled' }, { status: 400 });
      return Response.json({ device_code: 'device-code-1', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 });
    }
    if (url === 'https://github.com/login/oauth/access_token') {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get('client_id'), 'Iv23liTestClient');
      assert.equal(form.get('client_secret'), null, 'device-flow tokens refresh without the client secret');
      if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') return user.isAuthorized ? issueUserTokens() : Response.json({ error: 'authorization_pending' });
      assert.equal(form.get('grant_type'), 'refresh_token');
      const refreshToken = form.get('refresh_token') ?? '';
      user.refreshesWith.push(refreshToken);
      if (refreshToken !== user.liveRefreshToken) return Response.json({ error: 'bad_refresh_token' });
      return issueUserTokens();
    }
    if (url.startsWith('https://api.github.com/user')) {
      const accessToken = (headers.get('authorization') ?? '').replace('Bearer ', '');
      if (!user.liveAccessTokens.has(accessToken)) return Response.json({ message: 'Bad credentials' }, { status: 401 });
      const pathname = new URL(url).pathname;
      if (pathname === '/user') {
        user.userReads += 1;
        await user.userReadGate;
        return Response.json({ id: 7, login: 'octo' });
      }
      if (pathname === '/user/installations') return Response.json({ total_count: 2, installations: [{ id: 4242, account: { login: 'octo-org' } }, { id: 5151, account: { login: 'octo' } }] });
      if (pathname === '/user/installations/4242/repositories') return Response.json({ total_count: 2, repositories: [{ name: 'site' }, { name: 'glimmervoid' }] });
      if (pathname === '/user/installations/5151/repositories') return Response.json({ total_count: 0, repositories: [] });
      return Response.json({ message: 'Not Found' }, { status: 404 });
    }
    assert.equal(url, 'https://api.github.com/app/installations/4242/access_tokens', 'only an installation the user token reaches with at least one repository is minted');
    const [header, payload, signature] = (headers.get('authorization') ?? '').replace('Bearer ', '').split('.');
    assert.ok(crypto.verify('sha256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')), 'the JWT is signed with the App key');
    mints.push({ claims: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), body: JSON.parse(String(init?.body)), atMs: clock.nowMs });
    const lifetimeMs = tokenLifetimesMs[mints.length - 1] ?? 60 * 60_000;
    return Response.json({ token: `ghs_minted${mints.length}`, expires_at: new Date(clock.nowMs + lifetimeMs).toISOString() }, { status: 201 });
  };
  return { appFetch, mints, secretReads, user, githubApp: { clientId: 'Iv23liTestClient', slug: 'glimmervoid-test', privateKeySecret: secretName } };
}

async function signedWatcherCall(doormanPort: number, linkSecret: Buffer, method: 'GET' | 'POST', path: string, nowMs: number): Promise<GithubConnection> {
  const headers = signedHeaders(directionKey(linkSecret, 'server-to-watcher'), { method, path, body: '' }, nowMs);
  const response = await fetch(`http://127.0.0.1:${doormanPort}${path}`, { method, headers, body: method === 'POST' ? '' : undefined });
  assert.equal(response.status, 200);
  return GithubConnectionAnswer.parse(await response.json()).connection;
}

test('a doorman with a GitHub App binds the installation its tenant connected through the device flow, mints a read-only installation token scoped to the repositories the user reaches, probes with it while the server sends no read token, re-mints before the hour ends, hands the awake server that token over the signed link, and leaves an operator read token in charge', async (t) => {
  const clock = { nowMs: Date.now() };
  const app = fakeGithubApp(clock, [10 * 60_000 + 200]);
  const { linkSecret, tenant } = await doormanTenant(t, 'apptenant000001', 'http://127.0.0.1:9');
  const probeAuthorizations: string[] = [];
  const probeFetch: typeof fetch = async (_input, init) => {
    probeAuthorizations.push(new Headers(init?.headers).get('authorization') ?? '');
    return Response.json({ data: { viewer: { login: 'tenant' } } });
  };
  const doorman = createDoorman({
    table: { tenantDomain: null, githubApp: app.githubApp, tenants: [tenant] },
    probeFetch, githubAppFetch: app.appFetch, now: () => clock.nowMs, log: QUIET_LOG,
  });
  const doormanPort = await doorman.listen(0);
  assert.deepEqual(await signedWatcherCall(doormanPort, linkSecret, 'GET', GITHUB_CONNECTION_PATH, clock.nowMs), { state: 'disconnected' });
  const awaiting = await signedWatcherCall(doormanPort, linkSecret, 'POST', GITHUB_CONNECT_PATH, clock.nowMs);
  assert.deepEqual(awaiting, { state: 'awaiting-code', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAtMs: clock.nowMs + 900_000 });
  app.user.isAuthorized = true;
  const connected = await eventually(async () => {
    const connection = await signedWatcherCall(doormanPort, linkSecret, 'GET', GITHUB_CONNECTION_PATH, clock.nowMs);
    return connection.state === 'connected' ? connection : undefined;
  });
  assert.deepEqual(connected, { state: 'connected', login: 'octo', accounts: ['octo-org'], refreshTokenExpiresAtMs: connected.refreshTokenExpiresAtMs, installUrl: 'https://github.com/apps/glimmervoid-test/installations/new' }, 'an installation where the user reaches no repository is never bound');
  const sealedRecord = await fsp.readFile(path.join(tenant.watcherHome, 'records', 'github-user'));
  assert.ok(!sealedRecord.includes('ghr_user'), 'the refresh token is sealed at rest');
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
  assert.deepEqual(await link.githubConnection('read'), connected, 'the server reads the tenant connection over the signed link');
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

test('a tenant record read that fails answers the server as a failed mint and retries, never as a tenant with no GitHub installation', async (t) => {
  const clock = { nowMs: Date.now() };
  const app = fakeGithubApp(clock, []);
  const { linkSecret, tenant } = await doormanTenant(t, 'flakytenant0001', 'http://127.0.0.1:9');
  const fileStore = createFileTenantRecordStore({ watcherHomeFor: () => tenant.watcherHome });
  const storeHealth = { isReadFailing: false };
  const doorman = createDoorman({
    table: { tenantDomain: null, githubApp: app.githubApp, tenants: [tenant] },
    recordStore: {
      read: async (slug, recordName) => {
        if (storeHealth.isReadFailing) throw new Error('storage.googleapis.com answered 503');
        return fileStore.read(slug, recordName);
      },
      write: fileStore.write,
    },
    githubAppFetch: app.appFetch, now: () => clock.nowMs, log: QUIET_LOG,
  });
  t.after(() => doorman.close());
  const doormanPort = await doorman.listen(0);
  await signedWatcherCall(doormanPort, linkSecret, 'POST', GITHUB_CONNECT_PATH, clock.nowMs);
  app.user.isAuthorized = true;
  await eventually(async () => ((await signedWatcherCall(doormanPort, linkSecret, 'GET', GITHUB_CONNECTION_PATH, clock.nowMs)).state === 'connected' ? true : undefined));
  const askForToken = () => fetch(`http://127.0.0.1:${doormanPort}${GITHUB_TOKEN_PATH}`, { method: 'POST', headers: signedHeaders(directionKey(linkSecret, 'server-to-watcher'), { method: 'POST', path: GITHUB_TOKEN_PATH, body: '' }, clock.nowMs), body: '' });

  storeHealth.isReadFailing = true;
  assert.equal((await askForToken()).status, 503, 'an unreadable record is a failed mint the server retries soon');

  storeHealth.isReadFailing = false;
  clock.nowMs += 10 * 60_000;
  const answer = await askForToken();
  assert.equal(answer.status, 200);
  assert.match(GithubTokenAnswer.parse(await answer.json()).grant?.token ?? '', /^ghs_minted\d$/);
});

test('only one refresh of a tenant GitHub user token runs at a time, a doorman restart refreshes from the newest stored refresh token, a refused refresh asks for a reconnect, a disconnect outlasts a sign-in still finishing, and a disabled device flow reads as unavailable', async (t) => {
  const clock = { nowMs: Date.now() };
  const app = fakeGithubApp(clock, []);
  const watcherHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-github-user-'));
  t.after(() => fsp.rm(watcherHome, { recursive: true, force: true }));
  const store = createFileTenantRecordStore({ watcherHomeFor: (slug) => (slug === 'usertenant00001' ? watcherHome : null) });
  const sealKey = credentialStoreKey(crypto.randomBytes(32));
  const changes: string[] = [];
  const logLines: string[] = [];
  const recordingLog = { log: (line: string) => logLines.push(line), warn: (line: string) => logLines.push(line) };
  const openLink = () => createGithubUserLink({ slug: 'usertenant00001', app: () => app.githubApp, store, sealKey, fetchFn: app.appFetch, now: () => clock.nowMs, log: recordingLog, onChange: () => changes.push('changed') });
  const firstDoorman = openLink();
  t.after(() => firstDoorman.stop());

  app.user.isAuthorized = true;
  assert.equal((await firstDoorman.connect()).state, 'awaiting-code');
  await eventually(async () => ((await firstDoorman.connection()).state === 'connected' ? true : undefined));
  assert.deepEqual(await firstDoorman.bindings(), [{ installationId: 4242, accountLogin: 'octo-org', repositories: ['glimmervoid', 'site'] }]);

  clock.nowMs += 9 * 60 * 60_000;
  const [firstGrant, secondGrant] = await Promise.all([firstDoorman.userAccessGrant(), firstDoorman.userAccessGrant()]);
  assert.deepEqual(app.user.refreshesWith, ['ghr_user1'], 'two callers share one refresh');
  assert.equal(firstGrant?.token, 'ghu_user2');
  assert.equal(secondGrant?.token, 'ghu_user2');
  assert.equal(firstGrant?.login, 'octo');

  clock.nowMs += 9 * 60 * 60_000;
  const restartedDoorman = openLink();
  t.after(() => restartedDoorman.stop());
  const [stoppingGrant, restartedGrant] = await Promise.all([firstDoorman.userAccessGrant(), restartedDoorman.userAccessGrant()]);
  firstDoorman.stop();
  assert.equal(stoppingGrant?.token, 'ghu_user3');
  assert.equal(restartedGrant?.token, 'ghu_user4');
  assert.deepEqual(app.user.refreshesWith, ['ghr_user1', 'ghr_user2', 'ghr_user3'], 'a restarted doorman never reuses a refresh token its predecessor is spending');

  app.user.liveRefreshToken = null;
  clock.nowMs += 9 * 60 * 60_000;
  assert.equal(await restartedDoorman.userAccessGrant(), null);
  assert.deepEqual(await restartedDoorman.connection(), { state: 'reconnect-needed', login: 'octo', reason: 'revoked' });
  assert.deepEqual(await restartedDoorman.bindings(), [], 'a connection waiting for a reconnect binds nothing');
  assert.ok(changes.length > 0);

  assert.deepEqual(await restartedDoorman.disconnect(), { state: 'disconnected' });
  let releaseUserRead = () => {};
  app.user.userReadGate = new Promise((resolve) => {
    releaseUserRead = resolve;
  });
  const userReadsBefore = app.user.userReads;
  assert.equal((await restartedDoorman.connect()).state, 'awaiting-code');
  await eventually(() => (app.user.userReads > userReadsBefore ? true : undefined));
  assert.deepEqual(await restartedDoorman.disconnect(), { state: 'disconnected' });
  releaseUserRead();
  await eventually(() => (logLines.some((line) => line.includes('sign-in finished after a disconnect')) ? true : undefined));
  assert.deepEqual(await restartedDoorman.connection(), { state: 'disconnected' }, 'a sign-in that finishes after a disconnect binds nothing');
  assert.deepEqual(await restartedDoorman.bindings(), []);
  app.user.userReadGate = null;

  app.user.deviceFlowEnabled = false;
  assert.deepEqual(await restartedDoorman.connect(), { state: 'unavailable', reason: 'device-flow-off' });
});
