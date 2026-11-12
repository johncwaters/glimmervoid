import fs from 'node:fs';
import path from 'node:path';
import { clock } from '../../shared/clock.ts';
import { PackLauncherRuns } from '../../shared/contracts/pack.ts';
import type { PackSessionStart } from '../../shared/contracts/pack-launch.ts';
import { errorMessage } from '../../shared/text.ts';
import { DEFAULT_TIMER_FNS, unrefTimer } from '../../shared/timer-deps.ts';
import type { ClearTimeoutFn, SetTimeoutFn, TimerHandle } from '../../shared/timer-deps.ts';
import { DEFAULT_WAKE_LIMITS, nextCronFireAt } from '../core/wake-core.ts';
import { loadJsonStateFile, loadedJsonValue, writeTextAtomic } from '../json-file.ts';
import { decideScheduledFire, isRepositoryProject, launcherAddSession, resolveLauncherProject } from './core/launcher-core.ts';
import type { LauncherProjectResolution } from './core/pack-core.ts';
import type { ProjectOrigin } from './core/launcher-core.ts';
import type { ScheduledPackLauncher } from './core/pack-core.ts';
import type { createPackStore } from './pack-store.ts';

type PackStore = ReturnType<typeof createPackStore>;
type LaunchRequest = ReturnType<typeof launcherAddSession>;
type LaunchOutcome = { ok: true; request: LaunchRequest } | { ok: false; error: string };
type SessionStarter = (request: LaunchRequest) => Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>;

const LONGEST_SCHEDULE_TIMER_MS = 24 * 60 * 60 * 1000;

function runKeyOf(scheduled: ScheduledPackLauncher): string {
  return JSON.stringify([scheduled.pack, scheduled.launcher.id]);
}

function fireKeyOf(scheduled: ScheduledPackLauncher, timezone: string): string {
  return JSON.stringify([scheduled.pack, scheduled.launcher.id, scheduled.schedule, timezone]);
}

export function createPackLaunchers({
  packStore, projectPaths, originUrl, operatorSaneYolo, onResolved, log,
  runsPath, isSessionLive, liveSessionNames, maxScheduledSessions, timezone, now = clock.nowMs, setTimeoutFn = DEFAULT_TIMER_FNS.setTimeoutFn, clearTimeoutFn = DEFAULT_TIMER_FNS.clearTimeoutFn,
}: {
  packStore: PackStore;
  projectPaths: () => readonly string[];
  originUrl: (projectPath: string) => Promise<string | null>;
  operatorSaneYolo: () => boolean;
  onResolved: () => void;
  log: { warn: (message: string) => void };
  runsPath: string | null;
  isSessionLive: (sessionId: string) => boolean;
  liveSessionNames: () => readonly string[];
  maxScheduledSessions: () => number;
  timezone: () => string;
  now?: () => number;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
}) {
  let projectOrigins: readonly ProjectOrigin[] = [];
  let existingFolders: ReadonlySet<string> = new Set();
  let refreshes: Promise<void> = Promise.resolve();
  let startSession: SessionStarter | null = null;
  let scheduleTimer: TimerHandle | null = null;
  const nextFireAtByKey = new Map<string, number>();
  const sessionIdByRunKey = new Map<string, string>();
  let runsLoad: Promise<void> | null = null;
  let runWrites: Promise<void> = Promise.resolve();

  const resolve = (project: string) => resolveLauncherProject(project, projectOrigins, existingFolders);

  async function existingFoldersOf(projects: readonly string[]): Promise<Set<string>> {
    const folders = projects.filter((project) => !isRepositoryProject(project));
    const found = await Promise.all(folders.map((folder) => fs.promises.stat(folder).then((stats) => stats.isDirectory(), () => false)));
    return new Set(folders.filter((_folder, index) => found[index]));
  }

  async function originOfRepository(projectPath: string): Promise<string | null> {
    const hasGitFolder = await fs.promises.stat(path.join(projectPath, '.git')).then(() => true, () => false);
    return hasGitFolder ? originUrl(projectPath).catch(() => null) : null;
  }

  async function projectOriginsNow(): Promise<ProjectOrigin[]> {
    const paths = [...new Set(projectPaths())];
    const origins = await Promise.all(paths.map((projectPath) => originOfRepository(projectPath)));
    return paths.map((projectPath, index) => ({ path: path.resolve(projectPath), originUrl: origins[index] ?? null }));
  }

  async function refreshNow(): Promise<void> {
    const projects = packStore.launcherProjectsInUse();
    projectOrigins = projects.some(isRepositoryProject) ? await projectOriginsNow() : [];
    existingFolders = await existingFoldersOf(projects);
    packStore.setLauncherResolver(resolve);
    onResolved();
    armSchedule();
  }

  function refresh(): Promise<void> {
    refreshes = refreshes.then(refreshNow).catch((error: unknown) => log.warn(`[packs] could not match launcher projects: ${errorMessage(error)}`));
    return refreshes;
  }

  async function resolveFresh(project: string) {
    const cached = resolve(project);
    if (cached.ok) return cached;
    await refresh();
    return resolve(project);
  }

  async function launchRequest(packName: string, launcherId: string, sessionNames: readonly string[]): Promise<LaunchOutcome> {
    const approved = packStore.launcherInUse(packName, launcherId);
    if (!approved) return { ok: false, error: `No approved launcher ${launcherId} in pack ${packName}` };
    const resolution = await resolveFresh(approved.launcher.project);
    if (!resolution.ok) return { ok: false, error: `${approved.launcher.label} cannot start: ${resolution.reason}` };
    return {
      ok: true,
      request: launcherAddSession({ launcher: approved.launcher, sessions: approved.sessions, projectPath: resolution.path, sessionNames, operatorSaneYolo: operatorSaneYolo() }),
    };
  }

  async function resolvePanelProject(project: string): Promise<LauncherProjectResolution> {
    if (!isRepositoryProject(project)) return resolveLauncherProject(project, [], await existingFoldersOf([project]));
    const cached = resolve(project);
    if (cached.ok) return cached;
    return resolveLauncherProject(project, await projectOriginsNow(), existingFolders);
  }

  async function panelSessionRequest(packName: string, panelId: string, start: PackSessionStart, sessionNames: readonly string[]): Promise<LaunchOutcome> {
    const approved = packStore.panelInUse(packName, panelId);
    if (!approved?.panel.acts.includes('sessions')) return { ok: false, error: `No approved panel ${panelId} in pack ${packName} lists sessions under acts` };
    const resolution = await resolvePanelProject(start.project);
    if (!resolution.ok) return { ok: false, error: `${approved.panel.label} cannot start a session: ${resolution.reason}` };
    const launcher = { ...start, label: start.name ?? approved.panel.label };
    return {
      ok: true,
      request: launcherAddSession({ launcher, sessions: approved.sessions, projectPath: resolution.path, sessionNames, operatorSaneYolo: operatorSaneYolo() }),
    };
  }

  function panelMaySend(packName: string, panelId: string): boolean {
    return packStore.panelInUse(packName, panelId)?.panel.acts.includes('sessions') ?? false;
  }

  function liveScheduledSessionCount(): number {
    return [...sessionIdByRunKey.values()].filter(isSessionLive).length;
  }

  function loadRuns(): Promise<void> {
    runsLoad ??= runsPath === null ? Promise.resolve() : loadJsonStateFile({ filePath: runsPath, parse: (raw) => PackLauncherRuns.safeParse(raw).data ?? null }).then((outcome) => {
      const loaded = loadedJsonValue(outcome);
      for (const [runKey, sessionId] of Object.entries(loaded?.sessionIdByRun ?? {})) {
        if (!sessionIdByRunKey.has(runKey)) sessionIdByRunKey.set(runKey, sessionId);
      }
    });
    return runsLoad;
  }

  function saveRuns(startedRunKey: string): void {
    if (runsPath === null) return;
    const sessionIdByRun = Object.fromEntries([...sessionIdByRunKey].filter(([runKey, sessionId]) => runKey === startedRunKey || isSessionLive(sessionId)));
    runWrites = runWrites
      .then(() => writeTextAtomic(runsPath, `${JSON.stringify({ sessionIdByRun }, null, 2)}\n`, { mkdir: true }))
      .catch((error: unknown) => log.warn(`[packs] could not save the scheduled launcher runs to ${runsPath}: ${errorMessage(error)}`));
  }

  function skipNoteOf(decision: ReturnType<typeof decideScheduledFire>, resolution: LauncherProjectResolution, lateByMs: number): string | null {
    switch (decision) {
      case 'skip-missed': return `it came due ${Math.round(lateByMs / 60000)} minutes late, as after the host slept, so it is skipped as missed`;
      case 'skip-unresolved': return resolution.ok ? null : resolution.reason;
      case 'skip-cap': return `${maxScheduledSessions()} scheduled sessions are already live (packScheduledSessionsMax)`;
      default: return null;
    }
  }

  async function fireScheduled(scheduled: ScheduledPackLauncher, lateByMs: number): Promise<void> {
    if (!startSession) return;
    await loadRuns();
    const runKey = runKeyOf(scheduled);
    const previousSessionId = sessionIdByRunKey.get(runKey);
    const resolution = await resolveFresh(scheduled.launcher.project);
    const decision = decideScheduledFire({
      lateByMs,
      missedGraceMs: DEFAULT_WAKE_LIMITS.missedGraceMs,
      isProjectResolved: resolution.ok,
      isPreviousRunLive: previousSessionId !== undefined && isSessionLive(previousSessionId),
      liveScheduledCount: liveScheduledSessionCount(),
      maxScheduledSessions: maxScheduledSessions(),
    });
    const skipNote = skipNoteOf(decision, resolution, lateByMs);
    if (skipNote !== null) log.warn(`[packs] skipped the scheduled run of ${scheduled.launcher.label} in pack ${scheduled.pack}: ${skipNote}`);
    if (decision !== 'start' || !resolution.ok) return;
    const approved = packStore.launcherInUse(scheduled.pack, scheduled.launcher.id);
    if (!approved || approved.launcher.schedule !== scheduled.schedule) return;
    const request = launcherAddSession({ launcher: approved.launcher, sessions: approved.sessions, projectPath: resolution.path, sessionNames: liveSessionNames(), operatorSaneYolo: operatorSaneYolo() });
    const started = await startSession(request);
    if (!started.ok) {
      log.warn(`[packs] the scheduled run of ${scheduled.launcher.label} in pack ${scheduled.pack} did not start: ${started.error}`);
      return;
    }
    sessionIdByRunKey.set(runKey, started.sessionId);
    saveRuns(runKey);
  }

  async function fireDueLaunchers(): Promise<void> {
    scheduleTimer = null;
    const firedAt = now();
    const zone = timezone();
    const due = packStore.scheduledLaunchersInUse().flatMap((scheduled) => {
      const fireAt = nextFireAtByKey.get(fireKeyOf(scheduled, zone));
      return fireAt !== undefined && fireAt <= firedAt ? [{ scheduled, lateByMs: firedAt - fireAt }] : [];
    });
    for (const { scheduled } of due) nextFireAtByKey.delete(fireKeyOf(scheduled, zone));
    for (const { scheduled, lateByMs } of due) {
      await fireScheduled(scheduled, lateByMs).catch((error: unknown) => log.warn(`[packs] the scheduled run of ${scheduled.launcher.label} failed: ${errorMessage(error)}`));
    }
    armSchedule();
  }

  function armSchedule(): void {
    if (scheduleTimer) clearTimeoutFn(scheduleTimer);
    scheduleTimer = null;
    if (!startSession) return;
    const zone = timezone();
    const scheduled = packStore.scheduledLaunchersInUse();
    const currentKeys = new Set(scheduled.map((entry) => fireKeyOf(entry, zone)));
    for (const key of nextFireAtByKey.keys()) {
      if (!currentKeys.has(key)) nextFireAtByKey.delete(key);
    }
    const armedAt = now();
    for (const entry of scheduled) {
      const key = fireKeyOf(entry, zone);
      if (nextFireAtByKey.has(key)) continue;
      const fireAt = nextCronFireAt(entry.schedule, zone, armedAt);
      if (fireAt !== null) nextFireAtByKey.set(key, fireAt);
    }
    if (nextFireAtByKey.size === 0) return;
    const delayMs = Math.min(Math.max(0, Math.min(...nextFireAtByKey.values()) - armedAt), LONGEST_SCHEDULE_TIMER_MS);
    scheduleTimer = unrefTimer(setTimeoutFn(() => void fireDueLaunchers(), delayMs));
  }

  function attachSessionStarter(starter: SessionStarter): void {
    startSession = starter;
    armSchedule();
  }

  return { refresh, launchRequest, panelSessionRequest, panelMaySend, attachSessionStarter };
}

export type PackLaunchers = ReturnType<typeof createPackLaunchers>;
