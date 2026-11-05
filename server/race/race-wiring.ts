import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { AgentSetup } from '../../shared/contracts/agent-models.ts';
import type { RaceContestant, RaceRecord, RaceSpec } from '../../shared/contracts/race.ts';
import { REMOVED_CONTESTANT, raceProgress } from '../../shared/race-core.ts';
import { errorMessage } from '../../shared/text.ts';
import { readLaneResultFile } from '../lanes/lane-spawn.ts';
import type { JudgeInput } from './core/race-core.ts';
import { RACE_JUDGE_RESULT_FILENAME, judgeDiffFileName, judgePrompt, parseJudgeResult } from './core/race-core.ts';
import type { ContestantDiff } from './race-diff.ts';
import type { RaceStore } from './race-store.ts';

const SETTLE_CHECK_INTERVAL_MS = 15_000;
const JUDGE_TIMEOUT_MS = 30 * 60 * 1000;
const RACE_DIFF_MAX_CHARS = 200_000;

type ContestantLaunch = (contestant: RaceContestant, race: { raceId: string; startSha: string }) => { ok: true; sessionId: string } | { ok: false; error: string };

interface RaceStartPoint {
  startSha: string;
  baseBranch: string;
}

interface RaceGit {
  fetchOrigin: (args: { projectPath: string }) => Promise<{ ok: boolean }>;
  listIntegrationTips: (args: { projectPath: string; integrationBranch: string | null }) => Promise<{ ok: boolean } | { ok: true; integrationTips: { branch: string; sha: string | null }[] }>;
}

interface JudgeSpawnRequest {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  setup: AgentSetup;
  readPaths: string[];
  signal: AbortSignal;
}

interface RaceWiringDependencies {
  store: RaceStore;
  git: RaceGit;
  integrationBranch: () => string | null;
  broadcast: (frame: { type: 'race-status'; races: RaceRecord[] }) => void;
  log: Pick<Console, 'log' | 'warn'>;
  sessionStateOf?: (sessionId: string) => string;
  worktreeOf?: (sessionId: string) => string | null;
  diffOf?: (args: { worktreeDir: string; startSha: string }) => Promise<ContestantDiff>;
  spawnJudge?: ((request: JudgeSpawnRequest) => Promise<void>) | null;
  judgeRoot?: string | null;
  now?: () => number;
}

function createRaceWiring({
  store, git, integrationBranch, broadcast, log, sessionStateOf = () => REMOVED_CONTESTANT, worktreeOf = () => null,
  diffOf = async () => ({ ok: false, reason: 'diffs are unavailable' }), spawnJudge = null, judgeRoot = null, now = Date.now,
}: RaceWiringDependencies) {
  const raceById = new Map<string, RaceRecord>();
  let settleTimer: ReturnType<typeof setInterval> | null = null;

  function status(): { type: 'race-status'; races: RaceRecord[] } {
    return { type: 'race-status', races: [...raceById.values()].sort((left, right) => right.createdAt - left.createdAt) };
  }

  async function loadRaces(raceIds: readonly string[]): Promise<void> {
    for (const raceId of raceIds) {
      const record = await store.read(raceId);
      if (record) raceById.set(record.id, record.phase === 'judging' ? { ...record, phase: 'running' } : record);
    }
    if (raceById.size > 0) broadcast(status());
  }

  async function resolveStartPoint(repoPath: string): Promise<RaceStartPoint | null> {
    const fetched = await git.fetchOrigin({ projectPath: repoPath });
    if (!fetched.ok) log.warn(`[race] fetching origin in ${repoPath} failed; starting from the local integration branch`);
    const tips = await git.listIntegrationTips({ projectPath: repoPath, integrationBranch: integrationBranch() });
    const tip = 'integrationTips' in tips ? tips.integrationTips[0] : null;
    if (!tip?.sha) return null;
    return { startSha: tip.sha, baseBranch: tip.branch };
  }

  async function saveRecord(record: RaceRecord): Promise<string | null> {
    try {
      await store.write(record);
      return null;
    } catch (error) {
      log.warn(`[race] could not save race ${record.id}: ${errorMessage(error)}`);
      return errorMessage(error);
    }
  }

  async function start(spec: RaceSpec, launch: ContestantLaunch): Promise<{ ok: true; raceId: string; error: string | null } | { ok: false; error: string }> {
    const startPoint = await resolveStartPoint(spec.repoPath);
    if (!startPoint) return { ok: false, error: `Could not find the integration branch of ${spec.repoPath}.` };
    const raceId = randomUUID();
    const sessionIdByContestant: Record<string, string> = {};
    const savedBeforeLaunch = await saveRecord({ id: raceId, spec, ...startPoint, createdAt: now(), sessionIdByContestant, phase: 'running', diffStatsByContestant: {}, judge: null, judgeError: null, winnerContestantId: null });
    if (savedBeforeLaunch !== null) return { ok: false, error: `Could not save the race, so no contestant started: ${savedBeforeLaunch}` };
    const failures: string[] = [];
    for (const contestant of spec.contestants) {
      const launched = launch(contestant, { raceId, startSha: startPoint.startSha });
      if (launched.ok) sessionIdByContestant[contestant.id] = launched.sessionId;
      if (!launched.ok) failures.push(`${contestant.label}: ${launched.error}`);
    }
    if (Object.keys(sessionIdByContestant).length === 0) return { ok: false, error: failures.join(' ') };
    const record: RaceRecord = { id: raceId, spec, ...startPoint, createdAt: now(), sessionIdByContestant, phase: 'running', diffStatsByContestant: {}, judge: null, judgeError: null, winnerContestantId: null };
    raceById.set(raceId, record);
    const savedAfterLaunch = await saveRecord(record);
    if (savedAfterLaunch !== null) failures.push(`(the race file could not be updated: ${savedAfterLaunch})`);
    broadcast(status());
    log.log(`[race] started ${spec.title} with ${Object.keys(sessionIdByContestant).length} contestants from ${startPoint.baseBranch} at ${startPoint.startSha}`);
    return { ok: true, raceId, error: failures.length > 0 ? `Started with problems: ${failures.join(' ')}` : null };
  }

  async function updateRecord(raceId: string, change: (record: RaceRecord) => RaceRecord): Promise<RaceRecord | null> {
    const current = raceById.get(raceId);
    if (!current) return null;
    const next = change(current);
    raceById.set(raceId, next);
    await saveRecord(next);
    broadcast(status());
    return next;
  }

  async function collectJudgeInputs(record: RaceRecord, judgeDir: string): Promise<{ inputs: JudgeInput[]; statsByContestant: RaceRecord['diffStatsByContestant']; unreadable: string[] }> {
    const inputs: JudgeInput[] = [];
    const statsByContestant: RaceRecord['diffStatsByContestant'] = {};
    const unreadable: string[] = [];
    for (const contestant of record.spec.contestants) {
      const sessionId = record.sessionIdByContestant[contestant.id];
      const worktreeDir = sessionId ? worktreeOf(sessionId) : null;
      if (!worktreeDir) continue;
      const diff = await diffOf({ worktreeDir, startSha: record.startSha });
      if (!diff.ok) {
        log.warn(`[race] no diff for ${contestant.label} in ${record.spec.title}: ${diff.reason}`);
        unreadable.push(`${contestant.label} (${diff.reason})`);
        continue;
      }
      statsByContestant[contestant.id] = diff.stats;
      if (diff.diff.trim() === '') continue;
      const diffFileName = judgeDiffFileName(contestant);
      await fsp.writeFile(path.join(judgeDir, diffFileName), diff.diff.slice(0, RACE_DIFF_MAX_CHARS), 'utf8');
      inputs.push({ contestant, worktreeDir, diffFileName, stats: diff.stats });
    }
    return { inputs, statsByContestant, unreadable };
  }

  async function runJudgeOnce(record: RaceRecord, judgeDir: string): Promise<Pick<RaceRecord, 'diffStatsByContestant' | 'judge' | 'judgeError'>> {
    const { inputs, statsByContestant, unreadable } = await collectJudgeInputs(record, judgeDir);
    const unreadableNote = unreadable.length > 0 ? `Could not read the diff of ${unreadable.join(', ')}, so it was left out.` : null;
    const judgeSetup = record.spec.judge?.setup ?? null;
    if (!judgeSetup || !spawnJudge) return { diffStatsByContestant: statsByContestant, judge: null, judgeError: unreadableNote };
    if (inputs.length === 0) return { diffStatsByContestant: statsByContestant, judge: null, judgeError: unreadableNote ?? 'No contestant changed anything, so there was nothing to judge.' };
    const timeout = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
    await spawnJudge({
      id: `race-judge:${record.id}:${randomUUID().slice(0, 8)}`,
      name: `Race judge ${record.spec.title}`.slice(0, 64),
      prompt: judgePrompt(record, inputs),
      cwd: judgeDir,
      setup: judgeSetup,
      readPaths: inputs.map((input) => input.worktreeDir),
      signal: timeout,
    });
    const parsed = parseJudgeResult(await readLaneResultFile(path.join(judgeDir, RACE_JUDGE_RESULT_FILENAME)), inputs.map((input) => input.contestant.id));
    if (!parsed.ok) return { diffStatsByContestant: statsByContestant, judge: null, judgeError: timeout.aborted ? 'The judge ran out of time.' : `The judge failed: ${parsed.reason}.` };
    return { diffStatsByContestant: statsByContestant, judge: parsed.result, judgeError: unreadableNote };
  }

  async function runJudge(raceId: string): Promise<void> {
    const record = raceById.get(raceId);
    if (!record || !judgeRoot) return;
    await fsp.mkdir(judgeRoot, { recursive: true });
    const judgeDir = await fsp.mkdtemp(path.join(judgeRoot, 'judge-'));
    try {
      const outcome = await runJudgeOnce(record, judgeDir).catch((error: unknown) => ({ diffStatsByContestant: record.diffStatsByContestant, judge: null, judgeError: `The judge failed: ${errorMessage(error)}.` }));
      await updateRecord(raceId, (current) => ({ ...current, ...outcome, phase: 'judged' }));
      log.log(`[race] judged ${record.spec.title}${outcome.judgeError ? `: ${outcome.judgeError}` : ''}`);
    } finally {
      await fsp.rm(judgeDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function judge(raceId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const record = raceById.get(raceId);
    if (!record) return { ok: false, error: 'That race is not loaded.' };
    if (record.phase === 'judging') return { ok: false, error: 'The judge is already running for this race.' };
    if (!judgeRoot) return { ok: false, error: 'Judging is unavailable.' };
    await updateRecord(raceId, (current) => ({ ...current, phase: 'judging', judgeError: null }));
    void runJudge(raceId).catch((error: unknown) => log.warn(`[race] judging ${raceId} failed: ${errorMessage(error)}`));
    return { ok: true };
  }

  async function pickWinner(raceId: string, contestantId: string): Promise<{ ok: true; winnerSessionId: string; loserSessionIds: string[]; notes: string | null } | { ok: false; error: string }> {
    const record = raceById.get(raceId);
    if (!record) return { ok: false, error: 'That race is not loaded.' };
    if (record.winnerContestantId && record.winnerContestantId !== contestantId) return { ok: false, error: 'This race already has a different winner.' };
    const winnerSessionId = record.sessionIdByContestant[contestantId];
    if (!winnerSessionId) return { ok: false, error: 'That contestant is not in this race.' };
    if (sessionStateOf(winnerSessionId) === REMOVED_CONTESTANT) return { ok: false, error: 'That contestant was removed, so it cannot win.' };
    if (!record.winnerContestantId) {
      const withWinner = { ...record, winnerContestantId: contestantId };
      raceById.set(raceId, withWinner);
      const saveError = await saveRecord(withWinner);
      if (saveError !== null) {
        raceById.set(raceId, record);
        return { ok: false, error: `Could not save the winner, so no contestant was removed: ${saveError}` };
      }
      broadcast(status());
    }
    const loserSessionIds = Object.entries(record.sessionIdByContestant).filter(([id]) => id !== contestantId).map(([, sessionId]) => sessionId);
    return { ok: true, winnerSessionId, loserSessionIds, notes: record.judge?.notes[contestantId] ?? null };
  }

  function judgeSettledRaces(): void {
    for (const record of raceById.values()) {
      if (record.phase !== 'running' || record.winnerContestantId) continue;
      if (!raceProgress(Object.values(record.sessionIdByContestant), sessionStateOf).isAllSettled) continue;
      void judge(record.id);
    }
  }

  function startWatching(): void {
    if (settleTimer) return;
    settleTimer = setInterval(judgeSettledRaces, SETTLE_CHECK_INTERVAL_MS);
    settleTimer.unref?.();
  }

  function stopWatching(): void {
    if (settleTimer) clearInterval(settleTimer);
    settleTimer = null;
  }

  async function contestantDiffText(raceId: string, contestantId: string): Promise<{ ok: true; diff: string } | { ok: false; error: string }> {
    const record = raceById.get(raceId);
    const sessionId = record?.sessionIdByContestant[contestantId];
    const worktreeDir = sessionId ? worktreeOf(sessionId) : null;
    if (!record || !worktreeDir) return { ok: false, error: 'That contestant has no checkout any more.' };
    const diff = await diffOf({ worktreeDir, startSha: record.startSha });
    if (!diff.ok) return { ok: false, error: diff.reason };
    return { ok: true, diff: diff.diff.slice(0, RACE_DIFF_MAX_CHARS) };
  }

  return { status, loadRaces, start, judge, pickWinner, startWatching, stopWatching, contestantDiffText };
}

type RaceWiring = ReturnType<typeof createRaceWiring>;

export { createRaceWiring };
export type { RaceWiring };
