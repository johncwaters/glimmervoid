import crypto from 'node:crypto';
import http from 'node:http';
import { nextBackoffMs } from '../../shared/backoff.ts';
import { CREDENTIALS_PATH, MAX_LINK_BODY_BYTES, Nudge, NUDGES_PATH, PROBE_SET_PATH, STATUS_PATH, WatcherStatus } from '../../shared/contracts/watcher-link.ts';
import type { Probe, ProbeFailure, ProbeSet, WatcherCredentials } from '../../shared/contracts/watcher-link.ts';
import { createRecentRequestIds, directionKey, signedHeaders, signedRequestFromHeaders, verifyRequest } from './core/link-signing-core.ts';
import { createWatcherSupervisor } from './watcher-supervisor.ts';

interface ProbeSource {
  laneId: string;
  credential: Probe['credential'];
  probes: () => Probe[];
  onNudge: (nudge: Nudge) => void;
  onCoverageChange: (coveredProbes: readonly Probe[]) => void;
  onWatcherProblem: (problem: string | null) => void;
}

type FetchFn = typeof fetch;

const MISSING_CREDENTIAL_NAMES = { github: 'GitHub read token', posthog: 'PostHog read connection' } as const;

function hasCredentialFor(credential: Probe['credential'], heldCredentials: WatcherCredentials): boolean {
  return heldCredentials[credential] !== null;
}

function laneTimerSentence(laneIds: readonly string[]): string {
  if (laneIds.length === 1) return `${laneIds[0]} polls on its own timer`;
  return `${laneIds.join(', ')} poll on their own timers`;
}

const LOOPBACK_HOST = '127.0.0.1';
const RECOMPILE_DEBOUNCE_MS = 2_000;
const DELIVERY_TIMEOUT_MS = 15_000;
const DELIVERY_RETRY_BASE_MS = 1_000;
const DELIVERY_RETRY_MAX_MS = 60_000;

function requestOf(probe: Probe): string {
  return JSON.stringify([probe.method, probe.url, probe.body, probe.credential, probe.answerField ?? null]);
}

const CREDENTIAL_LABELS: Record<Probe['credential'], string> = { github: 'GitHub', posthog: 'PostHog' };

function watcherProblemOf(probe: Probe, failure: ProbeFailure): string {
  return `Watcher cannot read ${CREDENTIAL_LABELS[probe.credential]}: ${failure.status ?? failure.reason}`;
}

function revisionOf(probes: readonly Probe[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(probes)).digest('hex').slice(0, 32);
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

function createWatcherLink({ watcherHome, credentials, linkSecret, fetchFn = fetch, now = Date.now, startWatcher = createWatcherSupervisor, log = console }: {
  watcherHome: string;
  credentials: () => WatcherCredentials;
  linkSecret: Buffer;
  fetchFn?: FetchFn;
  now?: () => number;
  startWatcher?: typeof createWatcherSupervisor;
  log?: Pick<Console, 'log' | 'warn'>;
}) {
  const nudgeKey = directionKey(linkSecret, 'watcher-to-server');
  const commandKey = directionKey(linkSecret, 'server-to-watcher');
  const seenRequestIds = createRecentRequestIds();
  const sourcesByLaneId = new Map<string, ProbeSource>();
  const failureByProbeId = new Map<string, ProbeFailure>();
  const coverageByLaneId = new Map<string, string>();
  const problemByLaneId = new Map<string, string | null>();
  const loggedMissingCredentials = new Set<Probe['credential']>();
  let watcherUrl: string | null = null;
  let deliveredProbeSet: ProbeSet | null = null;
  let deliveredCredentialsDigest: string | null = null;
  let deliveryAttempts = 0;
  let deliveryTimer: NodeJS.Timeout | null = null;
  let recompileTimer: NodeJS.Timeout | null = null;
  let isDelivering = false;
  let watcherStartCount = 0;
  let statusReadCount = 0;
  let supervisor: ReturnType<typeof createWatcherSupervisor> | null = null;
  let nudgeServer: http.Server | null = null;

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
    return { revision: revisionOf(probes), probes };
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
      await response.body?.cancel();
      if (!response.ok) log.warn(`[watcher] ${path} answered ${response.status}`);
      return response.ok;
    } catch (postError) {
      log.warn(`[watcher] could not reach the watcher at ${path}: ${(postError as Error).message}`);
      return false;
    }
  }

  async function readWatcherStatus(): Promise<WatcherStatus | null> {
    if (watcherUrl === null) return null;
    try {
      const response = await fetchFn(new URL(STATUS_PATH, watcherUrl), {
        method: 'GET',
        headers: signedHeaders(commandKey, { method: 'GET', path: STATUS_PATH, body: '' }, now()),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
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

  async function adoptWatcherStatus(): Promise<boolean> {
    const status = await readWatcherStatus();
    if (status === null) return false;
    if (deliveredProbeSet === null || status.probeSetRevision !== deliveredProbeSet.revision) return true;
    for (const probeStatus of status.probes) {
      if (probeStatus.status === 'failing' && probeStatus.failure !== null) failureByProbeId.set(probeStatus.probeId, probeStatus.failure);
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
        log.log(`[watcher] delivered probe set ${probeSet.revision.slice(0, 8)} with ${probeSet.probes.length} probes`);
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

  function handleNudge(nudge: Nudge): void {
    if (nudge.kind === 'check-in' || nudge.probeId === null) {
      log.log(`[watcher] check-in at ${nudge.at}`);
      return;
    }
    const probe = deliveredProbeSet?.probes.find((candidate) => candidate.id === nudge.probeId);
    if (probe === undefined) return;
    if (nudge.kind === 'failing') {
      failureByProbeId.set(probe.id, nudge.failure ?? { status: null, reason: 'unknown reason' });
      log.warn(`[watcher] probe ${probe.id} is failing: ${nudge.failure?.reason ?? 'unknown reason'}`);
    }
    if (nudge.kind === 'recovered') failureByProbeId.delete(probe.id);
    if (nudge.kind !== 'failing') log.log(`[watcher] ${probe.laneId}: ${probe.id} ${nudge.kind}`);
    updateCoverage();
    if (nudge.kind !== 'failing') sourcesByLaneId.get(probe.laneId)?.onNudge(nudge);
  }

  async function answerNudgeRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
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

  function listenForNudges(): Promise<number> {
    const server = http.createServer((request, response) => {
      answerNudgeRequest(request, response).catch((answerError: unknown) => {
        log.warn(`[watcher] nudge request failed: ${(answerError as Error).message}`);
        if (!response.headersSent) response.writeHead(500).end();
      });
    });
    nudgeServer = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, LOOPBACK_HOST, () => {
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
  }

  function watcherEnded(): void {
    watcherUrl = null;
    deliveredProbeSet = null;
    deliveredCredentialsDigest = null;
    failureByProbeId.clear();
    updateCoverage();
  }

  async function start(): Promise<void> {
    const nudgePort = await listenForNudges();
    supervisor = startWatcher({
      linkSecret,
      serverUrl: `http://${LOOPBACK_HOST}:${nudgePort}`,
      watcherHome,
      onListening: (listeningUrl) => {
        watcherUrl = listeningUrl;
        watcherStartCount += 1;
        void deliver();
      },
      onEnded: watcherEnded,
      log,
    });
    supervisor.start();
  }

  function stop(): void {
    supervisor?.stop();
    nudgeServer?.close();
    if (deliveryTimer !== null) clearTimeout(deliveryTimer);
    if (recompileTimer !== null) clearTimeout(recompileTimer);
  }

  function registerProbeSource(source: ProbeSource): void {
    sourcesByLaneId.set(source.laneId, source);
    coverageByLaneId.set(source.laneId, '[]');
    problemByLaneId.set(source.laneId, null);
    source.onCoverageChange([]);
    probesMayHaveChanged();
  }

  return { start, stop, registerProbeSource, probesMayHaveChanged, credentialsMayHaveChanged: probesMayHaveChanged };
}

type WatcherLink = ReturnType<typeof createWatcherLink>;

export { createWatcherLink };
export type { ProbeSource, WatcherLink };
