import { appendFile, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import type { CoherenceReadingRow, ProjectCoherenceTrend } from '../../shared/contracts/coherence.ts';
import { COHERENCE_READING_REASON_MAX_CHARS, COHERENCE_TREND_WINDOW_ROWS } from '../../shared/contracts/coherence.ts';
import type { ServerMessageOf } from '../../shared/contracts/control-messages.ts';
import { errorMessage, isMissingFileError } from '../../shared/text.ts';
import { judgeCoherenceConfig } from './core/coherence-config-core.ts';
import {
  admitVerbReadings, COHERENCE_READING_SERIES_MAX_ROWS, COHERENCE_READING_UNAVAILABLE, hasComponentsMap, hasDeclaredMassCommands, isProjectWatched, needsComponents,
  parseDecomposeOutput, parseDriftOutput, parseMassOutput, parseReadingSeries, parseRedundancyOutput, refusedMassCommands, summarizeCoherenceTrend,
} from './core/coherence-readings-core.ts';
import type { CoherenceReadingVerb, CoherenceVerbReadings } from './core/coherence-readings-core.ts';
import { coherenceJournalStoreKey } from './core/coherence-session-core.ts';
import { configuredIntegrationBranch } from '../core/integration-branch-core.ts';
import { firstLine } from '../core/text-core.ts';
import { factoryGitEnvironment } from '../git/git-workspace.ts';
import type { GitWorkspaceInstance } from '../git/git-workspace.ts';
import { makeHostScratchDirectory } from '../host-scratch.ts';
import { writeTextAtomic } from '../json-file.ts';
import { createTickLoop } from '../lanes/lane-runner.ts';
import { createSerialQueue } from '../spawn-gate.ts';
import { createCoherenceRuntime } from './coherence-runtime.ts';
import {
  coherenceEnv, completedFailureStdout, nodeModulesHolding, readCoherenceConfigEntry, snapshotCheckout, wasKilledByTimeout, withGuardrailsLaunch,
} from './coherence-sandboxed-run.ts';
import type { GuardedCommand } from './coherence-sandboxed-run.ts';

interface ReadingsProject {
  id: string;
  path: string;
}

interface ProjectReadingsState {
  projectPath: string;
  seriesPath: string;
  rows: CoherenceReadingRow[];
  rowsInFile: number;
  observedSha: string | null;
  originFetchedAtMs: number | null;
  pendingSha: string | null;
  debounceTimer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
  isForgotten: boolean;
}

type VerbOutput = { ok: true; stdout: string } | { ok: false; reason: string };

interface CoherenceReadingsOptions {
  seriesRoot: string;
  listProjects: () => ReadingsProject[];
  readSettings: () => { isFactoryEnabled: boolean; isSettingOn: boolean };
  readIntegrationTip: (projectPath: string) => Promise<string | null>;
  fetchOrigin: GitWorkspaceInstance['fetchOrigin'];
  hasNativeControlAt: (projectPath: string, sha: string) => Promise<boolean>;
  broadcastControl: (message: ServerMessageOf<'project-coherence-trend'>) => void;
  cliPath?: string | null;
  intervalMs?: number;
  debounceMs?: number;
  timeoutMs?: number;
  now?: () => number;
  log?: Pick<Console, 'warn'>;
}

const READINGS_INTERVAL_MS = 60_000;
const ORIGIN_FETCH_INTERVAL_MS = 5 * 60_000;
const SERIES_FILE_MODE = 0o600;

function unavailableEverywhere(reason: string): CoherenceVerbReadings {
  const unavailable = { status: 'unavailable' as const, reason: reason.slice(0, COHERENCE_READING_REASON_MAX_CHARS) };
  return { drift: unavailable, decompose: unavailable, redundancy: unavailable, mass: unavailable };
}

function integrationTipReader(gitWorkspace: Pick<GitWorkspaceInstance, 'detectDefaultBranch' | 'listIntegrationTips'>, readConfig: () => { integrationBranch?: unknown }) {
  return async (projectPath: string): Promise<string | null> => {
    const branch = configuredIntegrationBranch(readConfig()) ?? await gitWorkspace.detectDefaultBranch({ projectPath });
    if (!branch) return null;
    const listed = await gitWorkspace.listIntegrationTips({ projectPath, integrationBranch: branch });
    if (!('integrationTips' in listed)) return null;
    return listed.integrationTips.find((candidate) => candidate.branch === branch)?.sha ?? null;
  };
}

function createCoherenceReadings({
  seriesRoot, listProjects, readSettings, readIntegrationTip, fetchOrigin, hasNativeControlAt, broadcastControl, cliPath = createCoherenceRuntime().cliPath,
  intervalMs = READINGS_INTERVAL_MS, debounceMs = 5_000, timeoutMs = 30_000, now = Date.now, log = console,
}: CoherenceReadingsOptions) {
  const states = new Map<string, ProjectReadingsState>();
  const pollQueue = createSerialQueue();
  let isStopped = false;

  function seriesPathOf(projectId: string): string {
    return path.join(seriesRoot, `${coherenceJournalStoreKey({ source: 'project', identity: projectId })}.jsonl`);
  }

  function forget(projectId: string): void {
    const state = states.get(projectId);
    if (!state) return;
    state.isForgotten = true;
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    states.delete(projectId);
  }

  async function loadState(project: ReadingsProject): Promise<ProjectReadingsState> {
    const existing = states.get(project.id);
    if (existing?.projectPath === project.path) return existing;
    forget(project.id);
    const seriesPath = seriesPathOf(project.id);
    const text = await readFile(seriesPath, 'utf8').catch((error: unknown) => {
      if (isMissingFileError(error)) return '';
      throw error;
    });
    const rows = parseReadingSeries(text);
    const loaded: ProjectReadingsState = {
      projectPath: project.path, seriesPath, rows, rowsInFile: text.split('\n').filter((line) => line.trim() !== '').length,
      observedSha: rows[rows.length - 1]?.sha ?? null, originFetchedAtMs: null, pendingSha: null, debounceTimer: null, inFlight: null, isForgotten: false,
    };
    states.set(project.id, loaded);
    return loaded;
  }

  async function appendRow(state: ProjectReadingsState, row: CoherenceReadingRow): Promise<void> {
    await mkdir(seriesRoot, { recursive: true, mode: 0o700 });
    state.rows = [...state.rows, row].slice(-COHERENCE_READING_SERIES_MAX_ROWS);
    if (state.rowsInFile + 1 > COHERENCE_READING_SERIES_MAX_ROWS) {
      await writeTextAtomic(state.seriesPath, state.rows.map((kept) => `${JSON.stringify(kept)}\n`).join(''), { mode: SERIES_FILE_MODE });
      state.rowsInFile = state.rows.length;
      return;
    }
    await appendFile(state.seriesPath, `${JSON.stringify(row)}\n`, { mode: SERIES_FILE_MODE });
    state.rowsInFile += 1;
  }

  function trendOf(state: ProjectReadingsState): ProjectCoherenceTrend | null {
    const latest = state.rows[state.rows.length - 1];
    if (!latest) return null;
    return { latest, trend: summarizeCoherenceTrend(state.rows) };
  }

  async function verbOutput(runGuarded: GuardedCommand, resolvedCliPath: string, verb: CoherenceReadingVerb, projectPath: string): Promise<VerbOutput> {
    try {
      return { ok: true, stdout: await runGuarded(process.execPath, [resolvedCliPath, verb], { timeoutMs }) };
    } catch (error) {
      const finishedStdout = completedFailureStdout(error);
      if (finishedStdout !== null) return { ok: true, stdout: finishedStdout };
      log.warn(`[coherence-readings] coherence ${verb} failed in ${projectPath}: ${firstLine(errorMessage(error))}`);
      return { ok: false, reason: wasKilledByTimeout(error) ? COHERENCE_READING_UNAVAILABLE.timedOut : COHERENCE_READING_UNAVAILABLE.failed };
    }
  }

  async function readVerb<Reading>(read: Promise<VerbOutput>, parse: (stdout: string) => Reading): Promise<Reading | { status: 'unavailable'; reason: string }> {
    const output = await read;
    if (!output.ok) return { status: 'unavailable', reason: output.reason };
    return parse(output.stdout);
  }

  async function readingsInSnapshot(projectPath: string, sha: string, resolvedCliPath: string, scratch: string): Promise<CoherenceVerbReadings> {
    const env = coherenceEnv(await factoryGitEnvironment(projectPath));
    const snapshot = await snapshotCheckout({ cwd: projectPath, snapshotRoot: path.join(scratch, 'snapshot'), env, source: { kind: 'commit', sha } });
    if (!snapshot.ok) return unavailableEverywhere(COHERENCE_READING_UNAVAILABLE.snapshotFailed);
    const configEntry = await readCoherenceConfigEntry(snapshot.cwd);
    const verdict = judgeCoherenceConfig(configEntry);
    if (!verdict.ok) return unavailableEverywhere(verdict.reason);
    const isComponentsMapped = configEntry.kind === 'file' && hasComponentsMap(configEntry.text);
    const isMassCommandDeclared = configEntry.kind === 'file' && hasDeclaredMassCommands(configEntry.text);
    const readablePaths = [await nodeModulesHolding(resolvedCliPath), await realpath(process.execPath)];
    const readings = await withGuardrailsLaunch({ scratch, snapshot, readablePaths, env }, async (runGuarded): Promise<CoherenceVerbReadings> => {
      const runVerb = (verb: CoherenceReadingVerb) => verbOutput(runGuarded, resolvedCliPath, verb, projectPath);
      return {
        drift: isComponentsMapped ? await readVerb(runVerb('drift'), parseDriftOutput) : needsComponents(),
        decompose: isComponentsMapped ? await readVerb(runVerb('decompose'), parseDecomposeOutput) : needsComponents(),
        redundancy: await readVerb(runVerb('redundancy'), parseRedundancyOutput),
        mass: isMassCommandDeclared ? refusedMassCommands() : await readVerb(runVerb('mass'), parseMassOutput),
      };
    });
    return readings ?? unavailableEverywhere(COHERENCE_READING_UNAVAILABLE.guardrails);
  }

  async function takeReading(projectPath: string, sha: string): Promise<CoherenceReadingRow> {
    const at = new Date(now()).toISOString();
    if (!cliPath) return { sha, at, ...unavailableEverywhere(COHERENCE_READING_UNAVAILABLE.noCli) };
    const scratch = await makeHostScratchDirectory('coherence-readings-');
    try {
      return { sha, at, ...admitVerbReadings(await readingsInSnapshot(projectPath, sha, cliPath, scratch)) };
    } catch (error) {
      log.warn(`[coherence-readings] reading ${sha} in ${projectPath} failed: ${firstLine(errorMessage(error))}`);
      return { sha, at, ...unavailableEverywhere(COHERENCE_READING_UNAVAILABLE.snapshotFailed) };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async function drainPending(projectId: string, state: ProjectReadingsState): Promise<void> {
    for (let sha = state.pendingSha; sha !== null && !isStopped && !state.isForgotten; sha = state.pendingSha) {
      state.pendingSha = null;
      const row = await takeReading(state.projectPath, sha);
      if (isStopped || state.isForgotten) return;
      await appendRow(state, row);
      const published = trendOf(state);
      if (published) broadcastControl({ type: 'project-coherence-trend', projectId, ...published });
    }
  }

  function startDrain(projectId: string, state: ProjectReadingsState): void {
    if (state.inFlight || isStopped || state.isForgotten) return;
    state.inFlight = drainPending(projectId, state)
      .catch((error: unknown) => log.warn(`[coherence-readings] recording a reading for ${projectId} failed: ${firstLine(errorMessage(error))}`))
      .finally(() => {
        state.inFlight = null;
      });
  }

  function requestReading(projectId: string, state: ProjectReadingsState, sha: string): void {
    state.pendingSha = sha;
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      startDrain(projectId, state);
    }, debounceMs);
    state.debounceTimer.unref();
  }

  async function fetchOriginWhenDue(state: ProjectReadingsState): Promise<void> {
    const nowMs = now();
    if (state.originFetchedAtMs !== null && nowMs - state.originFetchedAtMs < ORIGIN_FETCH_INTERVAL_MS) return;
    state.originFetchedAtMs = nowMs;
    const fetched = await fetchOrigin({ projectPath: state.projectPath });
    if (!fetched.ok) log.warn(`[coherence-readings] fetching origin in ${state.projectPath} failed, reading local refs: ${firstLine(fetched.err ?? '')}`);
  }

  async function observeProject(project: ReadingsProject): Promise<void> {
    const state = await loadState(project);
    await fetchOriginWhenDue(state);
    const tipSha = await readIntegrationTip(project.path);
    if (tipSha === null || tipSha === state.observedSha) return;
    const hasNativeInstall = await hasNativeControlAt(project.path, tipSha);
    state.observedSha = tipSha;
    if (hasNativeInstall) requestReading(project.id, state, tipSha);
  }

  async function pollOnce(): Promise<void> {
    const projects = listProjects();
    const configuredIds = new Set(projects.map((project) => project.id));
    for (const projectId of [...states.keys()]) {
      if (!configuredIds.has(projectId)) forget(projectId);
    }
    if (!isProjectWatched(readSettings())) return;
    for (const project of projects) {
      if (isStopped) return;
      await observeProject(project).catch((error: unknown) => log.warn(`[coherence-readings] watching ${project.id} failed: ${firstLine(errorMessage(error))}`));
    }
  }

  function pollNow(): Promise<void> {
    return pollQueue.run(pollOnce);
  }

  const loop = createTickLoop({
    tag: 'coherence-readings', intervalMs, firstTickDelayMs: () => intervalMs, log,
    tick: async () => {
      await pollNow();
      return undefined;
    },
  });

  async function stop(): Promise<void> {
    isStopped = true;
    await loop.stop();
    for (const state of states.values()) {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
    }
    await Promise.all([...states.values()].map((state) => state.inFlight));
  }

  async function readTrend(project: ReadingsProject): Promise<ProjectCoherenceTrend | null> {
    return trendOf(await loadState(project));
  }

  function readWindow(projectId: string): CoherenceReadingRow[] {
    return states.get(projectId)?.rows.slice(-COHERENCE_TREND_WINDOW_ROWS) ?? [];
  }

  function snapshotMessage(): ServerMessageOf<'project-coherence-trend-snapshot'> {
    const projects: Record<string, ProjectCoherenceTrend> = {};
    for (const [projectId, state] of states) {
      const published = trendOf(state);
      if (published) projects[projectId] = published;
    }
    return { type: 'project-coherence-trend-snapshot', projects };
  }

  return { start: () => loop.start(), stop, pollNow, readTrend, readWindow, snapshotMessage };
}

type CoherenceReadings = ReturnType<typeof createCoherenceReadings>;

export { createCoherenceReadings, integrationTipReader };
export type { CoherenceReadings };
