import fs from 'node:fs';
import path from 'node:path';
import { createTickLoop } from '../../server/lanes/lane-runner.ts';
import type { TickOutcome } from '../../server/lanes/lane-runner.ts';
import { writeJsonAtomic } from '../../server/json-file.ts';
import { SENT_EVENTS_FILENAME } from '../../shared/contracts/watchee-settings.ts';
import type { WatcheeSettingsFile, WatcheeSettingsReply } from '../../shared/contracts/watchee-settings.ts';
import { errorMessage } from '../../shared/text.ts';
import type { WatcheeJobKind } from '../../shared/contracts/watcher-jobs.ts';
import { WATCHEES } from '../watchees/registry.ts';
import type { WatcheeDetector } from '../watchees/watchee.ts';
import { createWatcheeJob, intervalStartMs, jobIdForEvent, pruneSentEvents } from './core/watchee-runner-core.ts';
import { restartDelayMs } from './core/watcher-core.ts';
import { fetchWatcheeSettings, sendJob } from './job-inbox-client.ts';
import { OWNER_ONLY_FILE_MODE, createWatcheeFileStore, readJsonFileOrUndefined, readWatcheeSettings, writeWatcheeSettings } from './watchee-settings.ts';

const SENT_EVENTS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const JOB_DELIVERY_ATTEMPTS = 3;
const IDLE_SETTINGS_CHECK_MS = 15 * 60_000;

interface RunningWatchee {
  everyMs: number;
  loop: ReturnType<typeof createTickLoop>;
  detector: WatcheeDetector<WatcheeJobKind>;
}

function createWatcheeRunner({ watcherHome, jobsUrl, settingsUrl, token, now = Date.now, log = console }: {
  watcherHome: string;
  jobsUrl: string;
  settingsUrl: string;
  token: string;
  now?: () => number;
  log?: Pick<Console, 'log' | 'warn'>;
}): { start(): Promise<void>; stop(): Promise<void>; refreshSettings(): Promise<void> } {
  const sentEventsPath = path.join(watcherHome, SENT_EVENTS_FILENAME);
  const runningByKind = new Map<WatcheeJobKind, RunningWatchee>();
  let currentReply: WatcheeSettingsReply | null = null;
  const kindsToResend = new Set<WatcheeJobKind>();
  let sentAtByJobId: Record<string, number> = {};
  let settingsRefresh: Promise<void> = Promise.resolve();
  let failedFirstFetchCount = 0;
  let firstFetchRetry: NodeJS.Timeout | null = null;
  let idleSettingsCheck: NodeJS.Timeout | null = null;
  let isStopped = false;

  async function start(): Promise<void> {
    sentAtByJobId = pruneSentEvents(await readSentEvents(), now(), SENT_EVENTS_MAX_AGE_MS);
    await fs.promises.mkdir(watcherHome, { recursive: true, mode: 0o700 });
    const cached = await readWatcheeSettings(watcherHome);
    if (cached.ok) await applySettings(cached.reply);
    if (!cached.ok) log.log(`[watcher] no saved watchee settings (${cached.reason}); fetching them from the inbox`);
    await refreshSettings();
  }

  function refreshSettings(): Promise<void> {
    settingsRefresh = settingsRefresh.then(fetchAndApplySettings);
    return settingsRefresh;
  }

  async function fetchAndApplySettings(): Promise<void> {
    if (isStopped) return;
    const fetched = await fetchWatcheeSettings({ settingsUrl, token });
    if (!fetched.ok && currentReply === null) {
      retryFirstFetch(fetched.reason);
      return;
    }
    if (!fetched.ok) {
      log.warn(`[watcher] could not fetch watchee settings: ${fetched.reason}; keeping the last ones`);
      return;
    }
    failedFirstFetchCount = 0;
    if (isStopped || fetched.reply.revision === currentReply?.revision) return;
    await writeWatcheeSettings(watcherHome, fetched.reply)
      .catch((error: unknown) => log.warn(`[watcher] could not save the watchee settings: ${errorMessage(error)}`));
    await applySettings(fetched.reply);
  }

  async function readSentEvents(): Promise<Record<string, number>> {
    const saved = await readJsonFileOrUndefined(sentEventsPath);
    if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
  }

  function retryFirstFetch(reason: string): void {
    if (isStopped) return;
    failedFirstFetchCount += 1;
    const delayMs = restartDelayMs(failedFirstFetchCount);
    log.warn(`[watcher] could not fetch watchee settings: ${reason}; no saved ones to watch with, trying again in ${Math.round(delayMs / 1000)}s`);
    firstFetchRetry = setTimeout(() => {
      firstFetchRetry = null;
      void refreshSettings();
    }, delayMs);
  }

  async function applySettings(reply: WatcheeSettingsReply): Promise<void> {
    currentReply = reply;
    for (const kind of Object.keys(WATCHEES) as WatcheeJobKind[]) kindsToResend.add(kind);
    for (const kind of Object.keys(WATCHEES) as WatcheeJobKind[]) await applyWatchee(kind, reply.settings);
    checkSettingsWhileIdle();
  }

  function checkSettingsWhileIdle(): void {
    if (idleSettingsCheck !== null) clearInterval(idleSettingsCheck);
    idleSettingsCheck = null;
    if (isStopped || runningByKind.size > 0) return;
    idleSettingsCheck = setInterval(() => { void refreshSettings(); }, IDLE_SETTINGS_CHECK_MS);
  }

  async function applyWatchee<Kind extends WatcheeJobKind>(kind: Kind, settings: WatcheeSettingsFile): Promise<void> {
    const watchee = WATCHEES[kind];
    const running = runningByKind.get(kind);
    const gate = watchee.gate(settings);
    if (!gate.run) {
      if (running) await stopWatchee(kind, running);
      log.log(`[watcher] ${watchee.laneId} not watching: ${gate.reason}`);
      return;
    }
    const trigger = watchee.trigger(settings);
    if (trigger.kind !== 'interval') return;
    if (running?.everyMs === trigger.everyMs) {
      running.loop.tickSoon();
      return;
    }
    if (running) await stopWatchee(kind, running);
    const detector = watchee.start({ watcherHome, files: createWatcheeFileStore(watcherHome), now, log });
    const loop = createTickLoop({
      tag: `watcher:${watchee.laneId}`,
      intervalMs: trigger.everyMs,
      tick: () => detectAndSend(kind, detector, trigger.everyMs),
      quickRetries: true,
      now,
      log,
    });
    runningByKind.set(kind, { everyMs: trigger.everyMs, loop, detector });
    await loop.start();
    log.log(`[watcher] ${watchee.laneId} watching every ${Math.round(trigger.everyMs / 60_000)} min`);
  }

  async function detectAndSend<Kind extends WatcheeJobKind>(kind: Kind, detector: WatcheeDetector<Kind>, everyMs: number): Promise<TickOutcome | undefined> {
    if (currentReply === null) return undefined;
    const watchee = WATCHEES[kind];
    const detected = await detector.detect(currentReply.settings);
    if (!detected.ok) {
      log.warn(`[watcher] ${watchee.laneId} could not detect: ${detected.reason}`);
      return detected.retryAfterMs === undefined ? { failed: true, error: detected.reason } : { failed: true, retryAfterMs: detected.retryAfterMs, error: detected.reason };
    }
    const intervalStart = intervalStartMs(now(), everyMs);
    for (const payload of detected.events) {
      const jobId = jobIdForEvent(kind, watchee.eventKey(payload, intervalStart));
      if (sentAtByJobId[jobId] !== undefined && !kindsToResend.has(kind)) continue;
      const delivery = await sendJob({ jobsUrl, token, job: createWatcheeJob(jobId, kind, payload, new Date(now())), maxAttempts: JOB_DELIVERY_ATTEMPTS });
      if (!delivery.ok) return { failed: true, error: `${watchee.laneId} job not delivered: ${delivery.reason}` };
      if (isNewerSettingsRevision(delivery.ack.settingsRevision)) void refreshSettings();
      await detector.acknowledged?.(payload);
      sentAtByJobId = { ...pruneSentEvents(sentAtByJobId, now(), SENT_EVENTS_MAX_AGE_MS), [jobId]: now() };
      await writeJsonAtomic(sentEventsPath, sentAtByJobId, { mode: OWNER_ONLY_FILE_MODE, enforceMode: true, mkdir: true });
    }
    kindsToResend.delete(kind);
    return undefined;
  }

  function isNewerSettingsRevision(settingsRevision: string | undefined): boolean {
    return settingsRevision !== undefined && settingsRevision !== currentReply?.revision;
  }

  async function stopWatchee(kind: WatcheeJobKind, running: RunningWatchee): Promise<void> {
    runningByKind.delete(kind);
    running.detector.stop();
    await running.loop.stop();
  }

  async function stop(): Promise<void> {
    isStopped = true;
    if (firstFetchRetry !== null) clearTimeout(firstFetchRetry);
    if (idleSettingsCheck !== null) clearInterval(idleSettingsCheck);
    await settingsRefresh;
    for (const [kind, running] of [...runningByKind]) await stopWatchee(kind, running);
  }

  return { start, stop, refreshSettings };
}

export { createWatcheeRunner };
