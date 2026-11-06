import fs from 'node:fs';
import path from 'node:path';
import { createTickLoop } from '../../server/lanes/lane-runner.ts';
import type { TickOutcome } from '../../server/lanes/lane-runner.ts';
import { writeJsonAtomic } from '../../server/json-file.ts';
import { canonicalizePath } from '../../shared/canonical-paths.ts';
import { SENT_EVENTS_FILENAME, WATCHEE_SETTINGS_FILENAME } from '../../shared/contracts/watchee-settings.ts';
import type { WatcheeSettingsFile } from '../../shared/contracts/watchee-settings.ts';
import type { WatcheeJobKind } from '../../shared/contracts/watcher-jobs.ts';
import { WATCHEES } from '../watchees/registry.ts';
import type { WatcheeDetector } from '../watchees/watchee.ts';
import { createWatcheeJob, intervalStartMs, jobIdForEvent, pruneSentEvents } from './core/watchee-runner-core.ts';
import { sendJob } from './job-inbox-client.ts';
import { OWNER_ONLY_FILE_MODE, readJsonFileOrUndefined, readWatcheeSettings } from './watchee-settings.ts';

const SENT_EVENTS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const JOB_DELIVERY_ATTEMPTS = 3;
const SETTINGS_RELOAD_DEBOUNCE_MS = 250;

interface RunningWatchee {
  everyMs: number;
  loop: ReturnType<typeof createTickLoop>;
  detector: WatcheeDetector<WatcheeJobKind>;
}

function createWatcheeRunner({ watcherHome, jobsUrl, token, now = Date.now, log = console }: {
  watcherHome: string;
  jobsUrl: string;
  token: string;
  now?: () => number;
  log?: Pick<Console, 'log' | 'warn'>;
}): { start(): Promise<void>; stop(): Promise<void> } {
  const sentEventsPath = path.join(watcherHome, SENT_EVENTS_FILENAME);
  const runningByKind = new Map<WatcheeJobKind, RunningWatchee>();
  let currentSettings: WatcheeSettingsFile | null = null;
  const kindsToResend = new Set<WatcheeJobKind>();
  let sentAtByJobId: Record<string, number> = {};
  let settingsWatcher: fs.FSWatcher | null = null;
  let pendingReload: NodeJS.Timeout | null = null;

  async function start(): Promise<void> {
    sentAtByJobId = pruneSentEvents(await readSentEvents(), now(), SENT_EVENTS_MAX_AGE_MS);
    await fs.promises.mkdir(watcherHome, { recursive: true, mode: 0o700 });
    await reload();
    settingsWatcher = fs.watch(canonicalizePath(watcherHome), (_event, filename) => {
      if (filename !== WATCHEE_SETTINGS_FILENAME) return;
      if (pendingReload !== null) clearTimeout(pendingReload);
      pendingReload = setTimeout(() => { void reload(); }, SETTINGS_RELOAD_DEBOUNCE_MS);
    });
  }

  async function readSentEvents(): Promise<Record<string, number>> {
    const saved = await readJsonFileOrUndefined(sentEventsPath);
    if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
  }

  async function reload(): Promise<void> {
    pendingReload = null;
    const read = await readWatcheeSettings(watcherHome);
    if (!read.ok) {
      log.warn(`[watcher] ${read.reason}; keeping the last good watchee settings`);
      return;
    }
    currentSettings = read.settings;
    for (const kind of Object.keys(WATCHEES) as WatcheeJobKind[]) kindsToResend.add(kind);
    for (const kind of Object.keys(WATCHEES) as WatcheeJobKind[]) await applyWatchee(kind, read.settings);
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
    const detector = watchee.start({ watcherHome, now, log });
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
    if (currentSettings === null) return undefined;
    const watchee = WATCHEES[kind];
    const detected = await detector.detect(currentSettings);
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
      sentAtByJobId = { ...pruneSentEvents(sentAtByJobId, now(), SENT_EVENTS_MAX_AGE_MS), [jobId]: now() };
      await writeJsonAtomic(sentEventsPath, sentAtByJobId, { mode: OWNER_ONLY_FILE_MODE, enforceMode: true, mkdir: true });
    }
    kindsToResend.delete(kind);
    return undefined;
  }

  async function stopWatchee(kind: WatcheeJobKind, running: RunningWatchee): Promise<void> {
    runningByKind.delete(kind);
    running.detector.stop();
    await running.loop.stop();
  }

  async function stop(): Promise<void> {
    settingsWatcher?.close();
    if (pendingReload !== null) clearTimeout(pendingReload);
    for (const [kind, running] of [...runningByKind]) await stopWatchee(kind, running);
  }

  return { start, stop };
}

export { createWatcheeRunner };
