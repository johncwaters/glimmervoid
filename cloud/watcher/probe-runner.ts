import crypto from 'node:crypto';
import { signedHeaders } from '../link/core/link-signing-core.ts';
import { githubApiOrigin, NUDGES_PATH } from '../../shared/contracts/watcher-link.ts';
import type { Nudge, Probe, ProbeSet, WatcherCredentials, WatcherStatus } from '../../shared/contracts/watcher-link.ts';
import { freshProbeMemory, memoryAfterCredentialChange, nextRunAtMs, probeOutcome, retryAfterMsFromHeaders } from './core/probe-core.ts';
import type { ProbeMemory, ProbeResponse } from './core/probe-core.ts';
import { NO_CREDENTIALS } from './watcher-home.ts';
import type { WatcherHome } from './watcher-home.ts';

type FetchFn = typeof fetch;

const PROBE_TIMEOUT_MS = 30_000;
const NUDGE_TIMEOUT_MS = 30_000;
const NUDGE_RETRY_BASE_MS = 1000;
const NUDGE_RETRY_MAX_MS = 300_000;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const CHECK_IN_EVERY_MS = 24 * 60 * 60_000;
const USER_AGENT = 'glimmervoid-watcher';
const GRAPHQL_PATH = '/graphql';

function requestFingerprint(probe: Probe): string {
  return crypto.createHash('sha256').update(JSON.stringify([probe.method, probe.url, probe.body, probe.credential, probe.answerField ?? null])).digest('hex');
}

function credentialKindsChanged(previous: WatcherCredentials, next: WatcherCredentials): Set<Probe['credential']> {
  const changedKinds = new Set<Probe['credential']>();
  if (previous.github !== next.github) changedKinds.add('github');
  if (JSON.stringify(previous.posthog) !== JSON.stringify(next.posthog)) changedKinds.add('posthog');
  return changedKinds;
}

function authorizationFor(probe: Probe, credentials: WatcherCredentials): string | { refusal: string } {
  const probeHost = new URL(probe.url).host;
  if (probe.credential === 'github') {
    if (credentials.github === null) return { refusal: 'no GitHub read credential yet' };
    const githubApiHost = new URL(githubApiOrigin(process.env)).host;
    if (probeHost !== githubApiHost) return { refusal: `a GitHub probe may only reach ${githubApiHost}` };
    return `Bearer ${credentials.github}`;
  }
  if (credentials.posthog === null) return { refusal: 'no PostHog read credential yet' };
  if (probeHost !== new URL(credentials.posthog.host).host) return { refusal: 'a PostHog probe may only reach the connected PostHog host' };
  return `Bearer ${credentials.posthog.apiKey}`;
}

async function sha256OfBody(response: Response): Promise<string> {
  const hash = crypto.createHash('sha256');
  if (response.body === null) return hash.digest('hex');
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest('hex');
}

function fieldOfAnswer(answerText: string, answerField: string): unknown {
  try {
    const answer: unknown = JSON.parse(answerText);
    if (typeof answer !== 'object' || answer === null || !Object.hasOwn(answer, answerField)) return undefined;
    return Object.getOwnPropertyDescriptor(answer, answerField)?.value;
  } catch {
    return undefined;
  }
}

function isGraphqlProbe(probe: Probe): boolean {
  return probe.credential === 'github' && new URL(probe.url).pathname === GRAPHQL_PATH;
}

function graphqlErrorOf(answerText: string): string | null {
  const errors = fieldOfAnswer(answerText, 'errors');
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const firstError: unknown = errors[0];
  const hasErrorType = typeof firstError === 'object' && firstError !== null && 'type' in firstError && typeof firstError.type === 'string';
  return `GraphQL error ${hasErrorType ? String(firstError.type) : 'without a type'}`;
}

async function answerOf(response: Response, probe: Probe): Promise<{ bodySha256: string; errorInAnswer: string | null }> {
  const isGraphql = isGraphqlProbe(probe);
  if (probe.answerField === undefined && !isGraphql) return { bodySha256: await sha256OfBody(response), errorInAnswer: null };
  const answerText = await response.text();
  const field = probe.answerField === undefined ? undefined : fieldOfAnswer(answerText, probe.answerField);
  const hashedText = field === undefined ? answerText : JSON.stringify(field);
  return { bodySha256: crypto.createHash('sha256').update(hashedText).digest('hex'), errorInAnswer: isGraphql ? graphqlErrorOf(answerText) : null };
}

function createNudgeSender({ serverUrl, signingKey, fetchFn = fetch, now = Date.now, log = console }: {
  serverUrl: string;
  signingKey: Buffer;
  fetchFn?: FetchFn;
  now?: () => number;
  log?: Pick<Console, 'warn'>;
}) {
  const nudgesUrl = new URL(NUDGES_PATH, serverUrl);
  const pendingNudges: Nudge[] = [];
  let failedAttempts = 0;
  let retryTimer: NodeJS.Timeout | null = null;
  let isSending = false;

  async function postNudge(nudge: Nudge): Promise<boolean> {
    const body = JSON.stringify(nudge);
    try {
      const response = await fetchFn(nudgesUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...signedHeaders(signingKey, { method: 'POST', path: nudgesUrl.pathname, body }, now()) },
        body,
        signal: AbortSignal.timeout(NUDGE_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (response.ok) return true;
      log.warn(`[watcher] the server answered a nudge with ${response.status}`);
      return response.status === 400;
    } catch (postError) {
      log.warn(`[watcher] could not reach the server with a nudge: ${(postError as Error).message}`);
      return false;
    }
  }

  async function drain(): Promise<void> {
    if (isSending) return;
    isSending = true;
    retryTimer = null;
    while (pendingNudges.length > 0) {
      const isDelivered = await postNudge(pendingNudges[0]);
      if (!isDelivered) {
        failedAttempts += 1;
        const delayMs = Math.min(NUDGE_RETRY_MAX_MS, NUDGE_RETRY_BASE_MS * 2 ** Math.min(failedAttempts, 20));
        retryTimer = setTimeout(() => void drain(), delayMs);
        isSending = false;
        return;
      }
      failedAttempts = 0;
      pendingNudges.shift();
    }
    isSending = false;
  }

  function send(kind: Nudge['kind'], probeId: string | null, failure: Nudge['failure']): void {
    const isAlreadyPending = pendingNudges.some((pending) => pending.probeId === probeId && pending.kind === kind);
    if (isAlreadyPending) return;
    pendingNudges.push({ nudgeId: crypto.randomUUID(), probeId, kind, failure, at: new Date(now()).toISOString() });
    if (retryTimer === null) void drain();
  }

  function stop(): void {
    if (retryTimer !== null) clearTimeout(retryTimer);
  }

  return { send, stop };
}

type NudgeSender = ReturnType<typeof createNudgeSender>;

function createProbeRunner({ home, nudges, fetchFn = fetch, now = Date.now, log = console }: {
  home: WatcherHome;
  nudges: Pick<NudgeSender, 'send'>;
  fetchFn?: FetchFn;
  now?: () => number;
  log?: Pick<Console, 'log' | 'warn'>;
}) {
  let probeSet: ProbeSet | null = null;
  let credentials: WatcherCredentials = NO_CREDENTIALS;
  let memoryByProbeId = new Map<string, ProbeMemory>();
  let wakeTimer: NodeJS.Timeout | null = null;
  let checkInTimer: NodeJS.Timeout | null = null;
  let runState: 'idle' | 'running' | 'stopped' = 'idle';

  function memoryOf(probe: Probe): ProbeMemory {
    const fingerprint = requestFingerprint(probe);
    const memory = memoryByProbeId.get(probe.id);
    if (memory?.requestFingerprint === fingerprint) return memory;
    const freshMemory = freshProbeMemory(fingerprint);
    memoryByProbeId.set(probe.id, freshMemory);
    return freshMemory;
  }

  async function responseOf(probe: Probe, memory: ProbeMemory): Promise<ProbeResponse> {
    const authorization = authorizationFor(probe, credentials);
    if (typeof authorization !== 'string') return { kind: 'unreachable', error: authorization.refusal };
    const headers: Record<string, string> = { authorization, 'user-agent': USER_AGENT, accept: 'application/json' };
    if (probe.method === 'GET' && memory.etag !== null) headers['if-none-match'] = memory.etag;
    if (probe.body !== null) headers['content-type'] = 'application/json';
    try {
      const response = await fetchFn(probe.url, { method: probe.method, headers, body: probe.body ?? undefined, redirect: 'error', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const { bodySha256, errorInAnswer } = await answerOf(response, probe);
      const retryAfterMs = retryAfterMsFromHeaders({ status: response.status, hasErrorInAnswer: errorInAnswer !== null }, {
        retryAfter: response.headers.get('retry-after'),
        rateLimitRemaining: response.headers.get('x-ratelimit-remaining'),
        rateLimitReset: response.headers.get('x-ratelimit-reset'),
      }, now());
      return { kind: 'answered', status: response.status, etag: response.headers.get('etag'), bodySha256, errorInAnswer, retryAfterMs };
    } catch (fetchError) {
      return { kind: 'unreachable', error: (fetchError as Error).message };
    }
  }

  async function runProbe(probe: Probe): Promise<void> {
    const memory = memoryOf(probe);
    const response = await responseOf(probe, memory);
    if (memoryByProbeId.get(probe.id) !== memory) return;
    const outcome = probeOutcome(memory, response, now());
    memoryByProbeId.set(probe.id, outcome.memory);
    if (outcome.nudge !== null) nudges.send(outcome.nudge, probe.id, outcome.memory.failure);
  }

  function scheduleWake(): void {
    if (wakeTimer !== null) clearTimeout(wakeTimer);
    wakeTimer = null;
    if (runState === 'stopped' || probeSet === null || probeSet.probes.length === 0) return;
    const nowMs = now();
    const earliestRunAtMs = Math.min(...probeSet.probes.map((probe) => nextRunAtMs(probe, memoryOf(probe), nowMs)));
    wakeTimer = setTimeout(() => void runDueProbes(), Math.min(MAX_TIMER_DELAY_MS, Math.max(0, earliestRunAtMs - nowMs)));
  }

  async function runDueProbes(): Promise<void> {
    if (runState !== 'idle' || probeSet === null) return;
    runState = 'running';
    const nowMs = now();
    const dueProbes = probeSet.probes.filter((probe) => nextRunAtMs(probe, memoryOf(probe), nowMs) <= nowMs);
    for (const probe of dueProbes) {
      if (runState !== 'running') return;
      await runProbe(probe);
    }
    if (runState === 'running') runState = 'idle';
    scheduleWake();
  }

  async function applyProbeSet(nextProbeSet: ProbeSet): Promise<void> {
    await home.saveProbeSet(nextProbeSet);
    probeSet = nextProbeSet;
    const liveProbeIds = new Set(nextProbeSet.probes.map((probe) => probe.id));
    memoryByProbeId = new Map([...memoryByProbeId].filter(([probeId]) => liveProbeIds.has(probeId)));
    log.log(`[watcher] probe set ${nextProbeSet.revision} holds ${nextProbeSet.probes.length} probes`);
    scheduleWake();
  }

  async function applyCredentials(nextCredentials: WatcherCredentials): Promise<void> {
    await home.saveCredentials(nextCredentials);
    const changedCredentialKinds = credentialKindsChanged(credentials, nextCredentials);
    credentials = nextCredentials;
    const credentialByProbeId = new Map((probeSet?.probes ?? []).map((probe) => [probe.id, probe.credential]));
    memoryByProbeId = new Map([...memoryByProbeId].map(([probeId, memory]) => {
      const credential = credentialByProbeId.get(probeId);
      return [probeId, memoryAfterCredentialChange(memory, credential !== undefined && changedCredentialKinds.has(credential))];
    }));
    scheduleWake();
  }

  async function start(): Promise<void> {
    credentials = await home.loadCredentials();
    probeSet = await home.loadProbeSet();
    scheduleWake();
    checkInTimer = setInterval(() => nudges.send('check-in', null, null), CHECK_IN_EVERY_MS);
  }

  function stop(): void {
    runState = 'stopped';
    if (wakeTimer !== null) clearTimeout(wakeTimer);
    if (checkInTimer !== null) clearInterval(checkInTimer);
  }

  function status(): WatcherStatus {
    return {
      probeSetRevision: probeSet?.revision ?? null,
      hasCredentials: { github: credentials.github !== null, posthog: credentials.posthog !== null },
      probes: (probeSet?.probes ?? []).map((probe) => {
        const memory = memoryOf(probe);
        return { probeId: probe.id, status: memory.status, lastRunAt: memory.lastRunAtMs === null ? null : new Date(memory.lastRunAtMs).toISOString(), failure: memory.failure };
      }),
    };
  }

  return { applyProbeSet, applyCredentials, start, stop, status };
}

type ProbeRunner = ReturnType<typeof createProbeRunner>;

export { createNudgeSender, createProbeRunner };
export type { NudgeSender, ProbeRunner };
