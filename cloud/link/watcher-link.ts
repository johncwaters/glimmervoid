import crypto from 'node:crypto';
import http from 'node:http';
import { nextBackoffMs } from '../../shared/backoff.ts';
import { CREDENTIALS_PATH, MAX_LINK_BODY_BYTES, Nudge, NUDGES_PATH, PROBE_SET_PATH } from '../../shared/contracts/watcher-link.ts';
import type { Probe, ProbeSet, WatcherCredentials } from '../../shared/contracts/watcher-link.ts';
import { createRecentRequestIds, directionKey, signedHeaders, signedRequestFromHeaders, verifyRequest } from './core/link-signing-core.ts';
import { createWatcherSupervisor } from './watcher-supervisor.ts';

interface ProbeSource {
  laneId: string;
  credential: Probe['credential'];
  probes: () => Probe[];
  onNudge: (nudge: Nudge) => void;
  onCoverageChange: (coveredProbes: readonly Probe[]) => void;
}

type FetchFn = typeof fetch;

const LOOPBACK_HOST = '127.0.0.1';
const RECOMPILE_DEBOUNCE_MS = 2_000;
const DELIVERY_TIMEOUT_MS = 15_000;
const DELIVERY_RETRY_BASE_MS = 1_000;
const DELIVERY_RETRY_MAX_MS = 60_000;

function requestOf(probe: Probe): string {
  return JSON.stringify([probe.method, probe.url, probe.body, probe.credential, probe.answerField ?? null]);
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
  const failingProbeIds = new Set<string>();
  const coverageByLaneId = new Map<string, string>();
  let watcherUrl: string | null = null;
  let deliveredProbeSet: ProbeSet | null = null;
  let deliveredCredentialsDigest: string | null = null;
  let deliveryAttempts = 0;
  let deliveryTimer: NodeJS.Timeout | null = null;
  let recompileTimer: NodeJS.Timeout | null = null;
  let isDelivering = false;
  let supervisor: ReturnType<typeof createWatcherSupervisor> | null = null;
  let nudgeServer: http.Server | null = null;

  function updateCoverage(): void {
    const isLinked = watcherUrl !== null && deliveredProbeSet !== null && deliveredCredentialsDigest !== null;
    const currentCredentials = credentials();
    for (const source of sourcesByLaneId.values()) {
      const hasCredential = source.credential === 'github' ? currentCredentials.github !== null : currentCredentials.posthog !== null;
      const deliveredProbes = isLinked && hasCredential ? deliveredProbeSet?.probes.filter((probe) => probe.laneId === source.laneId) ?? [] : [];
      const coveredProbes = deliveredProbes.filter((probe) => !failingProbeIds.has(probe.id));
      const coverageDigest = JSON.stringify(coveredProbes.map((probe) => [probe.id, requestOf(probe)]));
      if (coverageByLaneId.get(source.laneId) === coverageDigest) continue;
      coverageByLaneId.set(source.laneId, coverageDigest);
      log.log(`[watcher] ${source.laneId}: the watcher covers ${coveredProbes.length} of its probes`);
      source.onCoverageChange(coveredProbes);
    }
  }

  function forgetFailuresOfChangedRequests(previousProbeSet: ProbeSet | null, nextProbeSet: ProbeSet): void {
    const previousRequestById = new Map((previousProbeSet?.probes ?? []).map((probe) => [probe.id, requestOf(probe)]));
    for (const probe of nextProbeSet.probes) {
      if (previousRequestById.get(probe.id) !== requestOf(probe)) failingProbeIds.delete(probe.id);
    }
    const liveProbeIds = new Set(nextProbeSet.probes.map((probe) => probe.id));
    for (const probeId of failingProbeIds) {
      if (!liveProbeIds.has(probeId)) failingProbeIds.delete(probeId);
    }
  }

  function compileProbeSet(): ProbeSet {
    const probes = [...sourcesByLaneId.values()].flatMap((source) => source.probes());
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
      }
      const probeSet = compileProbeSet();
      if (probeSet.revision !== deliveredProbeSet?.revision) {
        if (!await postToWatcher(PROBE_SET_PATH, probeSet)) return scheduleDeliveryRetry();
        forgetFailuresOfChangedRequests(deliveredProbeSet, probeSet);
        deliveredProbeSet = probeSet;
      }
      deliveryAttempts = 0;
      updateCoverage();
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
    if (nudge.kind === 'check-in' || nudge.probeId === null) return;
    const probe = deliveredProbeSet?.probes.find((candidate) => candidate.id === nudge.probeId);
    if (probe === undefined) return;
    if (nudge.kind === 'failing') {
      failingProbeIds.add(probe.id);
      log.warn(`[watcher] probe ${probe.id} is failing: ${nudge.failure?.reason ?? 'unknown reason'}`);
    }
    if (nudge.kind === 'recovered') failingProbeIds.delete(probe.id);
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
    failingProbeIds.clear();
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
    source.onCoverageChange([]);
    probesMayHaveChanged();
  }

  return { start, stop, registerProbeSource, probesMayHaveChanged, credentialsMayHaveChanged: probesMayHaveChanged };
}

type WatcherLink = ReturnType<typeof createWatcherLink>;

export { createWatcherLink };
export type { ProbeSource, WatcherLink };
