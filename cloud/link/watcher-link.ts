import crypto from 'node:crypto';
import type http from 'node:http';
import { nextBackoffMs } from '../../shared/backoff.ts';
import { ALARMS_FEATURE, AWAKE_USAGE_PATH, AwakeUsageAnswer, CREDENTIALS_PATH, GITHUB_CONNECT_PATH, GITHUB_CONNECTION_PATH, GITHUB_DISCONNECT_PATH, GITHUB_TOKEN_PATH, GithubConnectionAnswer, GithubTokenAnswer, HOST_STOP_PATH, HostStopAnswer, MAX_LINK_BODY_BYTES, Nudge, NUDGES_PATH, PROBE_SET_PATH, STATUS_PATH, WATCHER_FEATURES_HEADER, WatcherStatus } from '../../shared/contracts/watcher-link.ts';
import type { Alarm, GithubTokenGrant, HostStopOutcome, Probe, ProbeFailure, ProbeSet, WatcherCredentials } from '../../shared/contracts/watcher-link.ts';
import type { Telemetry } from '../../server/telemetry.ts';
import type { WatcherRollup } from '../../shared/contracts/telemetry.ts';
import type { AwakeUsage, GithubConnection, GithubConnectionAction } from '../../shared/contracts/watcher-link.ts';
import { failureKindOf, telemetryLaneOf } from './watcher-telemetry-core.ts';
import { createRecentRequestIds, directionKey, signedHeaders, signedRequestFromHeaders, verifyRequest } from './core/link-signing-core.ts';
import type { WatcherStarter } from './remote-watcher-starter.ts';
import { clock } from '../../shared/clock.ts';

interface ProbeSource {
  laneId: string;
  credential: Probe['credential'];
  probes: () => Probe[];
  onNudge: (nudge: Nudge) => void;
  onCoverageChange: (coveredProbes: readonly Probe[]) => void;
  onWatcherProblem: (problem: string | null) => void;
}

interface AlarmSource {
  alarms: () => Alarm[];
  onAlarm: (alarmId: string) => void;
}

type FetchFn = typeof fetch;
type HostStopRequestOutcome = HostStopOutcome | 'failed';

const MISSING_CREDENTIAL_NAMES = { github: 'GitHub read token', posthog: 'PostHog read connection' } as const;

function laneTimerSentence(laneIds: readonly string[]): string {
  if (laneIds.length === 1) return `${laneIds[0]} polls on its own timer`;
  return `${laneIds.join(', ')} poll on their own timers`;
}

const RECOMPILE_DEBOUNCE_MS = 2_000;
const DELIVERY_TIMEOUT_MS = 15_000;
const GITHUB_CONNECTION_CALLS: Record<GithubConnectionAction, { method: 'GET' | 'POST'; path: string }> = {
  read: { method: 'GET', path: GITHUB_CONNECTION_PATH },
  connect: { method: 'POST', path: GITHUB_CONNECT_PATH },
  disconnect: { method: 'POST', path: GITHUB_DISCONNECT_PATH },
};
const DELIVERY_RETRY_BASE_MS = 1_000;
const DELIVERY_RETRY_MAX_MS = 60_000;
const GITHUB_TOKEN_CHECK_MS = 5 * 60_000;
const GITHUB_TOKEN_MIN_LIFE_MS = 45 * 60_000;
type GithubTokenState = { kind: 'unasked' } | { kind: 'no-app'; answeredAtMs: number } | { kind: 'minting'; grant: GithubTokenGrant };

const NO_GITHUB_APP_RECHECK_MS = 60 * 60_000;

function requestOf(probe: Probe): string {
  return JSON.stringify([probe.method, probe.url, probe.body, probe.credential, probe.answerField ?? null]);
}

const CREDENTIAL_LABELS: Record<Probe['credential'], string> = { github: 'GitHub', posthog: 'PostHog' };

function watcherProblemOf(probe: Probe, failure: ProbeFailure): string {
  return `Watcher cannot read ${CREDENTIAL_LABELS[probe.credential]}: ${failure.status ?? failure.reason}`;
}

function revisionOf(probes: readonly Probe[], alarms: readonly Alarm[]): string {
  return crypto.createHash('sha256').update(JSON.stringify([probes, alarms])).digest('hex').slice(0, 32);
}

function readLimitedBody(request: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    request.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_LINK_BODY_BYTES) {
        resolve(null);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function createWatcherLink({ credentials, linkSecret, fetchFn = fetch, now = clock.nowMs, startWatcher, log = console, telemetry = null, onGithubAppTokenChange = () => {} }: {
  credentials: () => WatcherCredentials;
  linkSecret: Buffer;
  fetchFn?: FetchFn;
  now?: () => number;
  startWatcher: WatcherStarter;
  log?: Pick<Console, 'log' | 'warn'>;
  telemetry?: Pick<Telemetry, 'capture'> | null;
  onGithubAppTokenChange?: () => void;
}) {
  const nudgeKey = directionKey(linkSecret, 'watcher-to-server');
  const commandKey = directionKey(linkSecret, 'server-to-watcher');
  const seenRequestIds = createRecentRequestIds();
  const sourcesByLaneId = new Map<string, ProbeSource>();
  let alarmSource: AlarmSource | null = null;
  let doesWatcherTakeAlarms = false;
  const failureByProbeId = new Map<string, ProbeFailure>();
  const coverageByLaneId = new Map<string, string>();
  const problemByLaneId = new Map<string, string | null>();
  const loggedMissingCredentials = new Set<Probe['credential']>();
  const failingSinceMsByProbeId = new Map<string, number>();
  const coveredProbeCountByLaneId = new Map<string, number>();
  let nudgeCountSinceRollup = 0;
  let watcherUrl: string | null = null;
  let deliveredProbeSet: ProbeSet | null = null;
  let deliveredCredentialsDigest: string | null = null;
  let deliveryAttempts = 0;
  let deliveryTimer: NodeJS.Timeout | null = null;
  let recompileTimer: NodeJS.Timeout | null = null;
  let isDelivering = false;
  let watcherStartCount = 0;
  let statusReadCount = 0;
  let supervisor: ReturnType<WatcherStarter> | null = null;
  let githubTokenState: GithubTokenState = { kind: 'unasked' };
  let githubTokenRequest: Promise<void> | null = null;
  let announcedGithubAppToken: string | null = null;
  let githubTokenTimer: NodeJS.Timeout | null = null;

  function hasCredentialFor(credential: Probe['credential'], heldCredentials: WatcherCredentials): boolean {
    return heldCredentials[credential] !== null || (credential === 'github' && githubTokenState.kind === 'minting');
  }

  function githubAppToken(): string | null {
    if (githubTokenState.kind !== 'minting' || now() >= githubTokenState.grant.expiresAtMs) return null;
    return githubTokenState.grant.token;
  }

  function updateCoverage(): void {
    const isLinked = watcherUrl !== null && deliveredProbeSet !== null && deliveredCredentialsDigest !== null;
    const currentCredentials = credentials();
    for (const source of sourcesByLaneId.values()) {
      const hasCredential = hasCredentialFor(source.credential, currentCredentials);
      const deliveredProbes = isLinked && hasCredential ? deliveredProbeSet?.probes.filter((probe) => probe.laneId === source.laneId) ?? [] : [];
      const coveredProbes = deliveredProbes.filter((probe) => !failureByProbeId.has(probe.id));
      const coverageDigest = JSON.stringify(coveredProbes.map((probe) => [probe.id, requestOf(probe)]));
      if (coverageByLaneId.get(source.laneId) === coverageDigest) continue;
      coverageByLaneId.set(source.laneId, coverageDigest);
      coveredProbeCountByLaneId.set(source.laneId, coveredProbes.length);
      log.log(`[watcher] ${source.laneId}: the watcher covers ${coveredProbes.length} of its probes`);
      source.onCoverageChange(coveredProbes);
    }
    updateProblems();
  }

  function updateProblems(): void {
    const isLinked = watcherUrl !== null && deliveredProbeSet !== null && deliveredCredentialsDigest !== null;
    const currentCredentials = credentials();
    for (const source of sourcesByLaneId.values()) {
      const hasCredential = hasCredentialFor(source.credential, currentCredentials);
      const failingProbe = !isLinked || !hasCredential ? undefined : deliveredProbeSet?.probes.find((probe) => probe.laneId === source.laneId && failureByProbeId.has(probe.id));
      const failure = failingProbe === undefined ? undefined : failureByProbeId.get(failingProbe.id);
      const problem = failingProbe === undefined || failure === undefined ? null : watcherProblemOf(failingProbe, failure);
      if (problemByLaneId.get(source.laneId) === problem) continue;
      problemByLaneId.set(source.laneId, problem);
      source.onWatcherProblem(problem);
    }
  }

  function forgetFailuresOfChangedRequests(previousProbeSet: ProbeSet | null, nextProbeSet: ProbeSet): void {
    const previousRequestById = new Map((previousProbeSet?.probes ?? []).map((probe) => [probe.id, requestOf(probe)]));
    for (const probe of nextProbeSet.probes) {
      if (previousRequestById.get(probe.id) !== requestOf(probe)) failureByProbeId.delete(probe.id);
    }
    const liveProbeIds = new Set(nextProbeSet.probes.map((probe) => probe.id));
    for (const probeId of failureByProbeId.keys()) {
      if (!liveProbeIds.has(probeId)) failureByProbeId.delete(probeId);
    }
    for (const probeId of failingSinceMsByProbeId.keys()) {
      if (!failureByProbeId.has(probeId)) failingSinceMsByProbeId.delete(probeId);
    }
  }

  function logMissingCredentialsOnce(heldCredentials: WatcherCredentials): void {
    for (const credential of ['github', 'posthog'] as const) {
      if (hasCredentialFor(credential, heldCredentials)) {
        loggedMissingCredentials.delete(credential);
        continue;
      }
      const waitingLaneIds = [...sourcesByLaneId.values()].filter((source) => source.credential === credential).map((source) => source.laneId);
      if (waitingLaneIds.length === 0 || loggedMissingCredentials.has(credential)) continue;
      loggedMissingCredentials.add(credential);
      log.log(`[watcher] no ${MISSING_CREDENTIAL_NAMES[credential]}: ${laneTimerSentence(waitingLaneIds)} until one is set in Settings`);
    }
  }

  function compileProbeSet(heldCredentials: WatcherCredentials): ProbeSet {
    logMissingCredentialsOnce(heldCredentials);
    const probes = [...sourcesByLaneId.values()].filter((source) => hasCredentialFor(source.credential, heldCredentials)).flatMap((source) => source.probes());
    const alarms = doesWatcherTakeAlarms ? alarmSource?.alarms() ?? [] : [];
    const revision = revisionOf(probes, alarms);
    return alarms.length === 0 ? { revision, probes } : { revision, probes, alarms };
  }

  function noteWatcherFeatures(response: Response): void {
    if (!response.ok) return;
    doesWatcherTakeAlarms = (response.headers.get(WATCHER_FEATURES_HEADER) ?? '').split(',').includes(ALARMS_FEATURE);
  }

  async function postToWatcher(path: string, payload: unknown): Promise<boolean> {
    if (watcherUrl === null) return false;
    const body = JSON.stringify(payload);
    try {
      const response = await fetchFn(new URL(path, watcherUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...signedHeaders(commandKey, { method: 'POST', path, body }, now()) },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      noteWatcherFeatures(response);
      await response.body?.cancel();
      if (!response.ok) log.warn(`[watcher] ${path} answered ${response.status}`);
      return response.ok;
    } catch (postError) {
      log.warn(`[watcher] could not reach the watcher at ${path}: ${(postError as Error).message}`);
      return false;
    }
  }

  async function requestHostStop(): Promise<HostStopRequestOutcome> {
    if (watcherUrl === null) return 'failed';
    try {
      const response = await fetchFn(new URL(HOST_STOP_PATH, watcherUrl), {
        method: 'POST',
        headers: signedHeaders(commandKey, { method: 'POST', path: HOST_STOP_PATH, body: '' }, now()),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        log.warn(`[watcher] ${HOST_STOP_PATH} answered ${response.status}`);
        return 'failed';
      }
      const answer = HostStopAnswer.safeParse(await response.json());
      return answer.success ? answer.data.outcome : 'failed';
    } catch (stopError) {
      log.warn(`[watcher] could not ask the doorman to stop this host: ${(stopError as Error).message}`);
      return 'failed';
    }
  }

  async function requestGithubToken(): Promise<GithubTokenAnswer | null> {
    if (watcherUrl === null) return null;
    try {
      const response = await fetchFn(new URL(GITHUB_TOKEN_PATH, watcherUrl), {
        method: 'POST',
        headers: signedHeaders(commandKey, { method: 'POST', path: GITHUB_TOKEN_PATH, body: '' }, now()),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        log.warn(`[watcher] ${GITHUB_TOKEN_PATH} answered ${response.status}`);
        return null;
      }
      const answer = GithubTokenAnswer.safeParse(await response.json());
      return answer.success ? answer.data : null;
    } catch (tokenError) {
      log.warn(`[watcher] could not ask the doorman for a GitHub token: ${(tokenError as Error).message}`);
      return null;
    }
  }

  function isGithubTokenDue(): boolean {
    if (githubTokenState.kind === 'no-app') return now() - githubTokenState.answeredAtMs >= NO_GITHUB_APP_RECHECK_MS;
    return githubTokenState.kind === 'unasked' || githubTokenState.grant.expiresAtMs - now() < GITHUB_TOKEN_MIN_LIFE_MS;
  }

  function adoptGithubTokenAnswer(answer: GithubTokenAnswer): void {
    const previousKind = githubTokenState.kind;
    githubTokenState = answer.grant === null ? { kind: 'no-app', answeredAtMs: now() } : { kind: 'minting', grant: answer.grant };
    if ((previousKind === 'minting') === (githubTokenState.kind === 'minting')) return;
    log.log(`[watcher] the doorman ${githubTokenState.kind === 'minting' ? 'mints' : 'has no'} GitHub App tokens for this server`);
    updateCoverage();
    probesMayHaveChanged();
  }

  function announceGithubAppTokenChange(): void {
    const currentGithubAppToken = githubAppToken();
    if ((currentGithubAppToken === null) === (announcedGithubAppToken === null)) return;
    announcedGithubAppToken = currentGithubAppToken;
    onGithubAppTokenChange();
  }

  async function checkGithubToken(): Promise<void> {
    if (githubTokenRequest !== null || watcherUrl === null || credentials().github !== null || !isGithubTokenDue()) return announceGithubAppTokenChange();
    githubTokenRequest = requestGithubToken().then((answer) => {
      if (answer !== null) adoptGithubTokenAnswer(answer);
    });
    try {
      await githubTokenRequest;
    } finally {
      githubTokenRequest = null;
    }
    announceGithubAppTokenChange();
  }

  async function readWatcherStatus(): Promise<WatcherStatus | null> {
    if (watcherUrl === null) return null;
    try {
      const response = await fetchFn(new URL(STATUS_PATH, watcherUrl), {
        method: 'GET',
        headers: signedHeaders(commandKey, { method: 'GET', path: STATUS_PATH, body: '' }, now()),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      noteWatcherFeatures(response);
      if (!response.ok) {
        await response.body?.cancel();
        log.warn(`[watcher] ${STATUS_PATH} answered ${response.status}`);
        return null;
      }
      const status = WatcherStatus.safeParse(await response.json());
      return status.success ? status.data : null;
    } catch (statusError) {
      log.warn(`[watcher] could not read the watcher status: ${(statusError as Error).message}`);
      return null;
    }
  }

  async function githubConnection(action: GithubConnectionAction): Promise<GithubConnection | null> {
    if (watcherUrl === null) return null;
    const { method, path } = GITHUB_CONNECTION_CALLS[action];
    try {
      const response = await fetchFn(new URL(path, watcherUrl), {
        method,
        headers: signedHeaders(commandKey, { method, path, body: '' }, now()),
        body: method === 'POST' ? '' : undefined,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        log.warn(`[watcher] ${path} answered ${response.status}`);
        return null;
      }
      const answer = GithubConnectionAnswer.safeParse(await response.json());
      if (answer.success) return answer.data.connection;
      log.warn(`[watcher] ${path} answered an unreadable connection: ${answer.error.message}`);
      return null;
    } catch (connectionError) {
      log.warn(`[watcher] could not reach ${path}: ${(connectionError as Error).message}`);
      return null;
    }
  }

  async function readAwakeUsage(): Promise<AwakeUsage | null> {
    if (watcherUrl === null) return null;
    try {
      const response = await fetchFn(new URL(AWAKE_USAGE_PATH, watcherUrl), {
        method: 'GET',
        headers: signedHeaders(commandKey, { method: 'GET', path: AWAKE_USAGE_PATH, body: '' }, now()),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const answer = AwakeUsageAnswer.safeParse(await response.json());
      if (answer.success) return answer.data.awakeUsage;
      log.warn(`[watcher] ${AWAKE_USAGE_PATH} answered an unreadable usage: ${answer.error.message}`);
      return null;
    } catch (usageError) {
      log.warn(`[watcher] could not read awake usage: ${(usageError as Error).message}`);
      return null;
    }
  }

  async function adoptWatcherStatus(): Promise<boolean> {
    const status = await readWatcherStatus();
    if (status === null) return false;
    if (deliveredProbeSet === null) return true;
    if (status.probeSetRevision !== deliveredProbeSet.revision) {
      log.warn('[watcher] the watcher holds a different probe set, delivering again');
      deliveredProbeSet = null;
      deliveredCredentialsDigest = null;
      updateCoverage();
      probesMayHaveChanged();
      return true;
    }
    for (const probeStatus of status.probes) {
      if (probeStatus.status !== 'failing' || probeStatus.failure === null) continue;
      const failingProbe = deliveredProbeSet.probes.find((probe) => probe.id === probeStatus.probeId);
      if (failingProbe === undefined || failureByProbeId.has(failingProbe.id)) continue;
      noteProbeFailing(failingProbe, probeStatus.failure);
    }
    updateCoverage();
    return true;
  }

  function scheduleDeliveryRetry(): void {
    deliveryAttempts += 1;
    const delayMs = nextBackoffMs({ attempt: deliveryAttempts, baseMs: DELIVERY_RETRY_BASE_MS, maxMs: DELIVERY_RETRY_MAX_MS, jitter: 'none' });
    deliveryTimer = setTimeout(() => void deliver(), delayMs);
    deliveryTimer.unref();
  }

  async function deliver(): Promise<void> {
    deliveryTimer = null;
    if (isDelivering || watcherUrl === null) return;
    isDelivering = true;
    try {
      const currentCredentials = credentials();
      const credentialsDigest = crypto.createHash('sha256').update(JSON.stringify(currentCredentials)).digest('hex');
      if (credentialsDigest !== deliveredCredentialsDigest) {
        if (!await postToWatcher(CREDENTIALS_PATH, currentCredentials)) return scheduleDeliveryRetry();
        deliveredCredentialsDigest = credentialsDigest;
        log.log(`[watcher] delivered credentials: github ${currentCredentials.github === null ? 'no' : 'yes'}, posthog ${currentCredentials.posthog === null ? 'no' : 'yes'}`);
      }
      const probeSet = compileProbeSet(currentCredentials);
      if (probeSet.revision !== deliveredProbeSet?.revision) {
        if (!await postToWatcher(PROBE_SET_PATH, probeSet)) return scheduleDeliveryRetry();
        log.log(`[watcher] delivered probe set ${probeSet.revision.slice(0, 8)} with ${probeSet.probes.length} probes and ${probeSet.alarms?.length ?? 0} alarms`);
        forgetFailuresOfChangedRequests(deliveredProbeSet, probeSet);
        deliveredProbeSet = probeSet;
      }
      deliveryAttempts = 0;
      updateCoverage();
      const startCountAtRead = watcherStartCount;
      if (statusReadCount < startCountAtRead) {
        if (!await adoptWatcherStatus()) return scheduleDeliveryRetry();
        statusReadCount = startCountAtRead;
      }
    } finally {
      isDelivering = false;
    }
  }

  function probesMayHaveChanged(): void {
    if (recompileTimer !== null) return;
    recompileTimer = setTimeout(() => {
      recompileTimer = null;
      if (deliveryTimer === null) void deliver();
    }, RECOMPILE_DEBOUNCE_MS);
    recompileTimer.unref();
  }

  function noteProbeFailing(probe: Probe, failure: ProbeFailure): void {
    failureByProbeId.set(probe.id, failure);
    log.warn(`[watcher] probe ${probe.id} is failing: ${failure.reason}`);
    if (!failingSinceMsByProbeId.has(probe.id)) failingSinceMsByProbeId.set(probe.id, now());
    telemetry?.capture('watcher_probe_failing', { lane: telemetryLaneOf(probe.laneId), credential: probe.credential, failure_kind: failureKindOf(failure) });
  }

  function noteProbeRecovered(probe: Probe): void {
    failureByProbeId.delete(probe.id);
    const failingSinceMs = failingSinceMsByProbeId.get(probe.id);
    failingSinceMsByProbeId.delete(probe.id);
    if (failingSinceMs === undefined) return;
    telemetry?.capture('watcher_probe_recovered', { lane: telemetryLaneOf(probe.laneId), credential: probe.credential, failing_seconds: Math.max(0, Math.round((now() - failingSinceMs) / 1000)) });
  }

  function noteLaneNudged(probe: Probe, kind: 'changed' | 'recovered'): void {
    nudgeCountSinceRollup += 1;
    log.log(`[watcher] ${probe.laneId}: ${probe.id} ${kind}`);
    telemetry?.capture('watcher_nudge_received', { lane: telemetryLaneOf(probe.laneId), kind });
  }

  function takeRollup(): WatcherRollup {
    const rollup = {
      probeCount: deliveredProbeSet?.probes.length ?? 0,
      coveredProbeCount: [...coveredProbeCountByLaneId.values()].reduce((total, count) => total + count, 0),
      nudgeCount: nudgeCountSinceRollup,
    };
    nudgeCountSinceRollup = 0;
    return rollup;
  }

  function handleNudge(nudge: Nudge): void {
    if (nudge.kind === 'check-in' || nudge.probeId === null) {
      log.log(`[watcher] check-in at ${nudge.at}`);
      return;
    }
    if (nudge.kind === 'alarm') {
      alarmSource?.onAlarm(nudge.probeId);
      return;
    }
    const probe = deliveredProbeSet?.probes.find((candidate) => candidate.id === nudge.probeId);
    if (probe === undefined) return;
    if (nudge.kind === 'failing') noteProbeFailing(probe, nudge.failure ?? { status: null, reason: 'unknown reason' });
    if (nudge.kind === 'recovered') noteProbeRecovered(probe);
    if (nudge.kind !== 'failing') noteLaneNudged(probe, nudge.kind);
    updateCoverage();
    if (nudge.kind !== 'failing') sourcesByLaneId.get(probe.laneId)?.onNudge(nudge);
  }

  async function replyToNudge(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://server').pathname;
    const reply = (status: number) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end('{}');
    };
    if (request.method !== 'POST' || path !== NUDGES_PATH) return reply(404);
    const body = await readLimitedBody(request);
    if (body === null) return reply(413);
    const verdict = verifyRequest(nudgeKey, signedRequestFromHeaders(request.headers, 'POST', path, body), now(), seenRequestIds);
    if (!verdict.ok) {
      log.warn(`[watcher] refused a nudge: ${verdict.reason}`);
      return reply(401);
    }
    const nudge = Nudge.safeParse(jsonOrNull(body));
    if (!nudge.success) return reply(400);
    handleNudge(nudge.data);
    return reply(200);
  }

  function answerNudgeRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
    replyToNudge(request, response).catch((answerError: unknown) => {
      log.warn(`[watcher] nudge request failed: ${(answerError as Error).message}`);
      if (!response.headersSent) response.writeHead(500).end();
    });
  }

  function watcherEnded(): void {
    watcherUrl = null;
    deliveredProbeSet = null;
    deliveredCredentialsDigest = null;
    failureByProbeId.clear();
    updateCoverage();
  }

  const linkedListeners = new Set<() => void>();

  function whenLinked(listener: () => void): void {
    linkedListeners.add(listener);
  }

  async function start(): Promise<void> {
    supervisor = startWatcher({
      linkSecret,
      onListening: (listeningUrl) => {
        const isNewLink = watcherUrl !== listeningUrl;
        watcherUrl = listeningUrl;
        watcherStartCount += 1;
        if (isNewLink) for (const listener of linkedListeners) listener();
        void deliver();
        void checkGithubToken();
      },
      onEnded: watcherEnded,
      log,
    });
    supervisor.start();
    githubTokenTimer = setInterval(() => void checkGithubToken(), GITHUB_TOKEN_CHECK_MS);
    githubTokenTimer.unref();
  }

  function stop(): void {
    supervisor?.stop();
    if (deliveryTimer !== null) clearTimeout(deliveryTimer);
    if (recompileTimer !== null) clearTimeout(recompileTimer);
    if (githubTokenTimer !== null) clearInterval(githubTokenTimer);
  }

  function registerProbeSource(source: ProbeSource): void {
    sourcesByLaneId.set(source.laneId, source);
    coverageByLaneId.set(source.laneId, '[]');
    problemByLaneId.set(source.laneId, null);
    source.onCoverageChange([]);
    probesMayHaveChanged();
  }

  function hostWoke(): void {
    supervisor?.checkNow();
  }

  function registerAlarmSource(source: AlarmSource): void {
    alarmSource = source;
    probesMayHaveChanged();
  }

  return { start, stop, registerProbeSource, registerAlarmSource, probesMayHaveChanged, credentialsMayHaveChanged: probesMayHaveChanged, takeRollup, answerNudgeRequest, requestHostStop, githubAppToken, githubConnection, readAwakeUsage, whenLinked, hostWoke };
}

type WatcherLink = ReturnType<typeof createWatcherLink>;

export { createWatcherLink };
export type { HostStopRequestOutcome, ProbeSource, WatcherLink };
