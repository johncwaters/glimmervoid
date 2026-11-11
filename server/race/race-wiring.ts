import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { AgentSetup } from '../../shared/contracts/agent-models.ts';
import { ContestantMetrics } from '../../shared/contracts/race.ts';
import type { CheckOutcome, ContestantFinish, JudgeVerdict, PanelResult, RaceCheck, RaceContestant, RaceHistory, RaceJudge, RaceRecord, RaceSpec } from '../../shared/contracts/race.ts';
import { REMOVED_CONTESTANT, contestantTimeline, seriesKey, seriesRoundIds, winnerNotesOf } from '../../shared/race-core.ts';
import type { StateTransition } from '../../shared/race-core.ts';
import { errorMessage } from '../../shared/text.ts';
import { readLaneResultFile } from '../lanes/lane-spawn.ts';
import { buildJudgePrompt as buildMatcherPrompt, extractReviewFindings, scoreCell, validateJudgeOutput as parseMatcherOutput } from '../core/review-score-core.ts';
import type { JudgeInput, SessionWatch } from './core/race-core.ts';
import { RACE_JUDGE_RESULT_FILENAME, REVIEW_FINDINGS_FILENAME, REVIEW_MATCH_RESULT_FILENAME, contestantFinish, judgeCheckFileName, judgeCheckoutDirName, judgeDiffFileName, judgeIdAt, judgeLabel, judgePrompt, panelStanding, parseJudgeVerdict, raceDeadline, raceHistory, unblindVerdict } from './core/race-core.ts';
import type { ContestantDiff } from './race-diff.ts';
import type { RaceStore } from './race-store.ts';
import type { ReviewCaseLibrary } from './review-cases.ts';

const SETTLE_CHECK_INTERVAL_MS = 15_000;
const JUDGE_TIMEOUT_MS = 30 * 60 * 1000;
const RACE_DIFF_MAX_CHARS = 200_000;
const REVIEW_FINDINGS_MAX_BYTES = 1024 * 1024;
const DEFAULT_MATCHER_SETUP: AgentSetup = { agent: 'claude-code', model: null, options: [], instructions: '' };

interface ChangedContestant {
  contestantId: string;
  exportedCheckoutDir: string;
  blindDiff: string;
  blindStats: JudgeInput['stats'];
  check: CheckOutcome | null;
}

type ContestantLaunch = (contestant: RaceContestant, race: { raceId: string; startSha: string }) => { ok: true; sessionId: string } | { ok: false; error: string };

interface RaceStartPoint {
  startSha: string;
  baseBranch: string;
}

interface RaceGit {
  fetchOrigin: (args: { projectPath: string }) => Promise<{ ok: boolean }>;
  fetchOriginCommit?: (args: { projectPath: string; sha: string }) => Promise<{ ok: boolean }>;
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

type RaceFrame = { type: 'race-status'; races: RaceRecord[] } | { type: 'race-history'; history: RaceHistory };

interface RaceWiringDependencies {
  store: RaceStore;
  git: RaceGit;
  integrationBranch: () => string | null;
  broadcast: (frame: RaceFrame) => void;
  log: Pick<Console, 'log' | 'warn'>;
  sessionStateOf?: (sessionId: string) => string;
  sessionWatchOf?: (sessionId: string) => Omit<SessionWatch, 'hasSettled'> | null;
  worktreeOf?: (sessionId: string) => string | null;
  diffOf?: (args: { worktreeDir: string; startSha: string; blindCheckoutDir?: string | null }) => Promise<ContestantDiff>;
  spawnJudge?: ((request: JudgeSpawnRequest) => Promise<void>) | null;
  runCheck?: (args: { worktreeDir: string; check: RaceCheck }) => Promise<CheckOutcome>;
  transitionsOf?: (sessionId: string) => readonly StateTransition[] | null;
  usageLookup?: () => (sessionId: string) => { tokens: number; costUSD: number } | null;
  judgeRoot?: string | null;
  reviewCases?: ReviewCaseLibrary | null;
  now?: () => number;
  random?: () => number;
}

function shuffled<Item>(items: readonly Item[], random: () => number): Item[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function createRaceWiring({
  store, git, integrationBranch, broadcast, log, sessionStateOf = () => REMOVED_CONTESTANT, sessionWatchOf, worktreeOf = () => null,
  diffOf = async () => ({ ok: false, reason: 'diffs are unavailable' }), spawnJudge = null, runCheck = async () => ({ status: 'unavailable', exitCode: null, reason: 'checks are unavailable', durationMs: 0, outputTail: '' }),
  transitionsOf = () => null, usageLookup = () => () => null, judgeRoot = null, reviewCases = null, now = Date.now, random = Math.random,
}: RaceWiringDependencies) {
  const raceById = new Map<string, RaceRecord>();
  const launchBySeries = new Map<string, ContestantLaunch>();
  const historyById = new Map<string, RaceRecord>();
  let history: RaceHistory = raceHistory([], new Set());
  let settleTimer: ReturnType<typeof setInterval> | null = null;
  let isWatchingStopped = false;

  function status(): { type: 'race-status'; races: RaceRecord[] } {
    return { type: 'race-status', races: [...raceById.values()].sort((left, right) => right.createdAt - left.createdAt) };
  }

  function historyFrame(): { type: 'race-history'; history: RaceHistory } {
    return { type: 'race-history', history };
  }

  function refoldHistory(): void {
    history = raceHistory([...historyById.values()], new Set(raceById.keys()));
    broadcast(historyFrame());
  }

  async function loadRaces(raceIds: readonly string[]): Promise<void> {
    const pending = [...raceIds];
    const visited = new Set<string>();
    for (let raceId = pending.shift(); raceId !== undefined; raceId = pending.shift()) {
      if (visited.has(raceId)) continue;
      visited.add(raceId);
      const record = await store.read(raceId);
      if (!record) continue;
      raceById.set(record.id, record.phase === 'judging' ? { ...record, phase: 'running' } : record);
      pending.push(...seriesRoundIds(record));
    }
    if (raceById.size > 0) broadcast(status());
    for (const record of await store.list()) historyById.set(record.id, record);
    refoldHistory();
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
      if (record.phase === 'judged') {
        historyById.set(record.id, record);
        refoldHistory();
      }
      return null;
    } catch (error) {
      log.warn(`[race] could not save race ${record.id}: ${errorMessage(error)}`);
      return errorMessage(error);
    }
  }

  async function resolveReviewStartPoint(spec: RaceSpec): Promise<RaceStartPoint | null> {
    const reviewCase = spec.reviewCase;
    if (!reviewCase || !git.fetchOriginCommit) return null;
    const fetched = await git.fetchOriginCommit({ projectPath: spec.repoPath, sha: reviewCase.headSha });
    if (!fetched.ok) return null;
    return { startSha: reviewCase.headSha, baseBranch: `${reviewCase.repo} case ${reviewCase.caseId}` };
  }

  async function start(spec: RaceSpec, launch: ContestantLaunch): Promise<{ ok: true; raceId: string; error: string | null } | { ok: false; error: string }> {
    if (spec.reviewCase) {
      const reviewStart = await resolveReviewStartPoint(spec);
      if (!reviewStart) return { ok: false, error: `Could not fetch the reviewed commit ${spec.reviewCase.headSha} of ${spec.reviewCase.repo} into ${spec.repoPath}; pick a clone of that repository.` };
      return startSeries(spec, launch, reviewStart);
    }
    const startPoint = await resolveStartPoint(spec.repoPath);
    if (!startPoint) return { ok: false, error: `Could not find the integration branch of ${spec.repoPath}.` };
    return startSeries(spec, launch, startPoint);
  }

  async function startSeries(spec: RaceSpec, launch: ContestantLaunch, startPoint: RaceStartPoint): Promise<{ ok: true; raceId: string; error: string | null } | { ok: false; error: string }> {
    const raceId = randomUUID();
    const series = spec.rounds > 1 ? { id: raceId, round: 1 } : null;
    if (series) launchBySeries.set(series.id, launch);
    return startRound(raceId, spec, launch, startPoint, series);
  }

  async function startRound(raceId: string, spec: RaceSpec, launch: ContestantLaunch, startPoint: RaceStartPoint, series: RaceRecord['series']): Promise<{ ok: true; raceId: string; error: string | null } | { ok: false; error: string }> {
    const sessionIdByContestant: Record<string, string> = {};
    const freshRecord = (): RaceRecord => ({ id: raceId, spec, ...startPoint, createdAt: now(), sessionIdByContestant, phase: 'running', diffStatsByContestant: {}, checkByContestant: {}, metricsByContestant: {}, finishByContestant: {}, judge: null, panel: null, judgeError: null, recallByContestant: {}, winnerContestantId: null, series });
    const savedBeforeLaunch = await saveRecord(freshRecord());
    if (savedBeforeLaunch !== null) return { ok: false, error: `Could not save the race, so no contestant started: ${savedBeforeLaunch}` };
    const failures: string[] = [];
    for (const contestant of spec.contestants) {
      const launched = launch(contestant, { raceId, startSha: startPoint.startSha });
      if (launched.ok) sessionIdByContestant[contestant.id] = launched.sessionId;
      if (!launched.ok) failures.push(`${contestant.label}: ${launched.error}`);
    }
    if (Object.keys(sessionIdByContestant).length === 0) return { ok: false, error: failures.join(' ') };
    const record = freshRecord();
    raceById.set(raceId, record);
    const savedAfterLaunch = await saveRecord(record);
    if (savedAfterLaunch !== null) failures.push(`(the race file could not be updated: ${savedAfterLaunch})`);
    broadcast(status());
    log.log(`[race] started ${spec.title}${series ? ` round ${series.round} of ${spec.rounds}` : ''} with ${Object.keys(sessionIdByContestant).length} contestants from ${startPoint.baseBranch} at ${startPoint.startSha}`);
    return { ok: true, raceId, error: failures.length > 0 ? `Started with problems: ${failures.join(' ')}` : null };
  }

  function seriesRecords(record: RaceRecord): RaceRecord[] {
    const key = seriesKey(record);
    return [...raceById.values()].filter((candidate) => seriesKey(candidate) === key);
  }

  async function startNextRound(record: RaceRecord): Promise<void> {
    if (!record.series || record.series.round >= record.spec.rounds) return;
    const launch = launchBySeries.get(record.series.id);
    if (!launch) {
      log.warn(`[race] ${record.spec.title} cannot start round ${record.series.round + 1}: the server restarted since the race began`);
      return;
    }
    const siblings = seriesRecords(record);
    if (siblings.some((sibling) => sibling.winnerContestantId !== null)) return;
    if (siblings.some((sibling) => sibling.series && record.series && sibling.series.round > record.series.round)) return;
    const nextRound = { id: record.series.id, round: record.series.round + 1 };
    const nextRoundId = seriesRoundIds(record)[nextRound.round - 1] ?? randomUUID();
    const started = await startRound(nextRoundId, record.spec, launch, { startSha: record.startSha, baseBranch: record.baseBranch }, nextRound);
    if (!started.ok) log.warn(`[race] ${record.spec.title} round ${nextRound.round} did not start: ${started.error}`);
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

  async function collectChangedContestants(record: RaceRecord, judgeDir: string): Promise<{ changed: ChangedContestant[]; statsByContestant: RaceRecord['diffStatsByContestant']; checkByContestant: RaceRecord['checkByContestant']; unreadable: string[] }> {
    const changed: ChangedContestant[] = [];
    const statsByContestant: RaceRecord['diffStatsByContestant'] = {};
    const checkByContestant: RaceRecord['checkByContestant'] = {};
    const unreadable: string[] = [];
    for (const [lineupIndex, contestant] of record.spec.contestants.entries()) {
      const sessionId = record.sessionIdByContestant[contestant.id];
      const worktreeDir = sessionId ? worktreeOf(sessionId) : null;
      if (!worktreeDir) continue;
      if (record.finishByContestant[contestant.id]?.status === 'did-not-finish') {
        const partial = await diffOf({ worktreeDir, startSha: record.startSha });
        if (partial.ok) statsByContestant[contestant.id] = partial.stats;
        continue;
      }
      const exportedCheckoutDir = path.join(judgeDir, `export-${lineupIndex}`);
      const diff = await diffOf({ worktreeDir, startSha: record.startSha, blindCheckoutDir: exportedCheckoutDir });
      const isJudged = diff.ok && diff.blindDiff.trim() !== '';
      if (!isJudged) await fsp.rm(exportedCheckoutDir, { recursive: true, force: true });
      if (!diff.ok) {
        log.warn(`[race] no diff for ${contestant.label} in ${record.spec.title}: ${diff.reason}`);
        unreadable.push(`${contestant.label} (${diff.reason})`);
        continue;
      }
      statsByContestant[contestant.id] = diff.stats;
      if (!isJudged) continue;
      const check = record.spec.check ? await runCheck({ worktreeDir, check: record.spec.check }) : null;
      if (check) checkByContestant[contestant.id] = check;
      changed.push({ contestantId: contestant.id, exportedCheckoutDir, blindDiff: diff.blindDiff, blindStats: diff.blindStats, check });
    }
    return { changed, statsByContestant, checkByContestant, unreadable };
  }

  async function layoutJudgeDir(changed: readonly ChangedContestant[], judgeDir: string): Promise<{ inputs: JudgeInput[]; contestantIdByJudgeId: Map<string, string> }> {
    await fsp.mkdir(judgeDir, { recursive: true });
    const contestantIdByJudgeId = new Map<string, string>();
    const inputs: JudgeInput[] = [];
    for (const [index, contestant] of shuffled(changed, random).entries()) {
      const judgeId = judgeIdAt(index);
      contestantIdByJudgeId.set(judgeId, contestant.contestantId);
      const diffFileName = judgeDiffFileName(judgeId);
      const checkoutDirName = judgeCheckoutDirName(judgeId);
      const checkFileName = judgeCheckFileName(judgeId);
      await fsp.writeFile(path.join(judgeDir, diffFileName), contestant.blindDiff.slice(0, RACE_DIFF_MAX_CHARS), 'utf8');
      if (contestant.check && contestant.check.status !== 'unavailable') await fsp.writeFile(path.join(judgeDir, checkFileName), contestant.check.outputTail, 'utf8');
      await fsp.cp(contestant.exportedCheckoutDir, path.join(judgeDir, checkoutDirName), { recursive: true, verbatimSymlinks: true });
      inputs.push({ judgeId, checkoutDirName, diffFileName, checkFileName, stats: contestant.blindStats, check: contestant.check });
    }
    return { inputs, contestantIdByJudgeId };
  }

  async function runOneJudge(spawn: NonNullable<typeof spawnJudge>, record: RaceRecord, judge: RaceJudge, judgeIndex: number, changed: readonly ChangedContestant[], judgeRootDir: string, signal: AbortSignal): Promise<{ ok: true; verdict: JudgeVerdict } | { ok: false; reason: string }> {
    const judgeDir = path.join(judgeRootDir, `judge-${judgeIndex}`);
    const { inputs, contestantIdByJudgeId } = await layoutJudgeDir(changed, judgeDir);
    try {
      await spawn({
        id: `race-judge:${record.id}:${randomUUID().slice(0, 8)}`,
        name: `Race judge ${judgeIndex + 1} ${record.spec.title}`.slice(0, 64),
        prompt: judgePrompt(record, inputs),
        cwd: judgeDir,
        setup: judge.setup,
        readPaths: inputs.map((input) => path.join(judgeDir, input.checkoutDirName)),
        signal,
      });
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
    const parsed = parseJudgeVerdict(await readLaneResultFile(path.join(judgeDir, RACE_JUDGE_RESULT_FILENAME)), inputs.map((input) => input.judgeId));
    if (!parsed.ok) return { ok: false, reason: signal.aborted ? 'ran out of time' : parsed.reason };
    return { ok: true, verdict: unblindVerdict({ judge: { agent: judge.setup.agent, model: judge.setup.model, label: judgeLabel(judge.setup) }, contestants: parsed.contestants }, contestantIdByJudgeId) };
  }

  async function runJudgeOnce(record: RaceRecord, judgeDir: string): Promise<Pick<RaceRecord, 'diffStatsByContestant' | 'checkByContestant' | 'panel' | 'judgeError'>> {
    const { changed, statsByContestant, checkByContestant, unreadable } = await collectChangedContestants(record, judgeDir);
    const unreadableNote = unreadable.length > 0 ? `Could not read the diff of ${unreadable.join(', ')}, so it was left out.` : null;
    const collected = { diffStatsByContestant: statsByContestant, checkByContestant };
    if (record.spec.reviewCase || record.spec.judges.length === 0 || !spawnJudge) return { ...collected, panel: null, judgeError: unreadableNote };
    if (changed.length === 0) return { ...collected, panel: null, judgeError: unreadableNote ?? 'No contestant changed anything, so there was nothing to judge.' };
    const timeout = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
    const spawn = spawnJudge;
    const outcomes = await Promise.all(record.spec.judges.map((judge, judgeIndex) => runOneJudge(spawn, record, judge, judgeIndex, changed, judgeDir, timeout)));
    const verdicts = outcomes.flatMap((outcome) => (outcome.ok ? [outcome.verdict] : []));
    const failures = outcomes.flatMap((outcome, judgeIndex) => (outcome.ok ? [] : [{ label: judgeLabel(record.spec.judges[judgeIndex].setup), reason: outcome.reason.slice(0, 400) }]));
    if (verdicts.length === 0) return { ...collected, panel: null, judgeError: `Every judge failed: ${failures.map((failure) => `${failure.label} ${failure.reason}`).join('; ')}.` };
    const panel: PanelResult = { verdicts, failures, ...panelStanding(verdicts, changed.map((contestant) => contestant.contestantId)) };
    return { ...collected, panel, judgeError: unreadableNote };
  }

  async function readReviewFindings(worktreeDir: string): Promise<string[]> {
    const findingsPath = path.join(worktreeDir, REVIEW_FINDINGS_FILENAME);
    const stat = await fsp.lstat(findingsPath).catch(() => null);
    if (!stat?.isFile() || stat.size > REVIEW_FINDINGS_MAX_BYTES) return [];
    return extractReviewFindings(await fsp.readFile(findingsPath, 'utf8').catch(() => ''));
  }

  async function matchContestant(spawn: NonNullable<typeof spawnJudge>, record: RaceRecord, lineupIndex: number, findings: readonly string[], judgeDir: string, signal: AbortSignal): Promise<{ ok: true; recall: number } | { ok: false; reason: string }> {
    const reviewCase = record.spec.reviewCase;
    if (!reviewCase) return { ok: false, reason: 'the race has no review case' };
    if (findings.length === 0) return { ok: true, recall: 0 };
    const matcherDir = path.join(judgeDir, `matcher-${lineupIndex}`);
    await fsp.mkdir(matcherDir, { recursive: true });
    const matcher = buildMatcherPrompt({ references: reviewCase.references, findings: findings.map((body) => ({ path: null, line: null, severity: null, lane: null, body })), seed: lineupIndex + 1 });
    try {
      await spawn({
        id: `race-matcher:${record.id}:${randomUUID().slice(0, 8)}`,
        name: `Race matcher ${lineupIndex + 1} ${record.spec.title}`.slice(0, 64),
        prompt: `${matcher.prompt}\n\nWrite exactly that JSON, and nothing else, to ./${REVIEW_MATCH_RESULT_FILENAME} with the Write tool.`,
        cwd: matcherDir,
        setup: record.spec.judges[0]?.setup ?? DEFAULT_MATCHER_SETUP,
        readPaths: [],
        signal,
      });
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
    const parsed = parseMatcherOutput(JSON.stringify(await readLaneResultFile(path.join(matcherDir, REVIEW_MATCH_RESULT_FILENAME))), { referenceIds: reviewCase.references.map((reference) => reference.id), shownToOriginal: matcher.shownToOriginal });
    if (!parsed.ok) return { ok: false, reason: signal.aborted ? 'ran out of time' : parsed.reason };
    return { ok: true, recall: scoreCell(parsed.judgements, reviewCase.references).recall };
  }

  async function scoreRecall(record: RaceRecord, judgeDir: string): Promise<{ recallByContestant: RaceRecord['recallByContestant']; failures: string[] }> {
    if (!record.spec.reviewCase || !spawnJudge) return { recallByContestant: {}, failures: [] };
    const spawn = spawnJudge;
    const timeout = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
    const recallByContestant: RaceRecord['recallByContestant'] = {};
    const failures: string[] = [];
    await Promise.all(record.spec.contestants.map(async (contestant, lineupIndex) => {
      const sessionId = record.sessionIdByContestant[contestant.id];
      const worktreeDir = sessionId ? worktreeOf(sessionId) : null;
      if (!worktreeDir || record.finishByContestant[contestant.id]?.status === 'did-not-finish') return;
      const matched = await matchContestant(spawn, record, lineupIndex, await readReviewFindings(worktreeDir), judgeDir, timeout);
      if (matched.ok) recallByContestant[contestant.id] = matched.recall;
      if (!matched.ok) failures.push(`Could not score the review of ${contestant.label}: ${matched.reason.slice(0, 300)}.`);
    }));
    return { recallByContestant, failures };
  }

  function measureContestants(record: RaceRecord): RaceRecord['metricsByContestant'] {
    const usageOf = usageLookup();
    const metricsByContestant: RaceRecord['metricsByContestant'] = {};
    for (const [contestantId, sessionId] of Object.entries(record.sessionIdByContestant)) {
      const storedMetrics = record.metricsByContestant[contestantId];
      if (storedMetrics) {
        metricsByContestant[contestantId] = storedMetrics;
        continue;
      }
      const transitions = transitionsOf(sessionId);
      if (!transitions) continue;
      const timeline = contestantTimeline(record.createdAt, transitions);
      const usage = usageOf(sessionId);
      const measured = ContestantMetrics.safeParse({ ...timeline, tokens: usage?.tokens ?? null, costUSD: usage?.costUSD ?? null });
      metricsByContestant[contestantId] = measured.success ? measured.data : { ...timeline, tokens: null, costUSD: null };
    }
    return metricsByContestant;
  }

  function watchOf(record: RaceRecord, sessionId: string): SessionWatch | null {
    const live = sessionWatchOf ? sessionWatchOf(sessionId) : { state: sessionStateOf(sessionId), stateSince: now(), waitingOn: null };
    if (!live) return null;
    const transitions = transitionsOf(sessionId);
    const hasSettled = transitions !== null && contestantTimeline(record.createdAt, transitions).elapsedMs !== null;
    return { ...live, hasSettled };
  }

  function finishesNow(record: RaceRecord): Record<string, ContestantFinish | null> {
    const deadline = raceDeadline(record);
    const checkedAt = now();
    const finishes: Record<string, ContestantFinish | null> = {};
    for (const [contestantId, sessionId] of Object.entries(record.sessionIdByContestant)) {
      const watch = watchOf(record, sessionId);
      const storedFinish = record.finishByContestant[contestantId];
      finishes[contestantId] = !watch && storedFinish ? storedFinish : contestantFinish(watch, deadline, checkedAt);
    }
    return finishes;
  }

  function finishOfContestants(record: RaceRecord): RaceRecord['finishByContestant'] {
    return decidedFinishes(finishesNow(record));
  }

  function decidedFinishes(finishes: Record<string, ContestantFinish | null>): RaceRecord['finishByContestant'] {
    return Object.fromEntries(Object.entries(finishes).flatMap(([contestantId, finish]) => (finish ? [[contestantId, finish]] : [])));
  }

  async function runJudge(raceId: string, finishesAtTrigger: RaceRecord['finishByContestant'] | null): Promise<void> {
    const record = raceById.get(raceId);
    if (!record || !judgeRoot) return;
    await fsp.mkdir(judgeRoot, { recursive: true });
    const judgeDir = await fsp.mkdtemp(path.join(judgeRoot, 'judge-'));
    const metricsByContestant = measureContestants(record);
    const finishByContestant = finishesAtTrigger ?? finishOfContestants(record);
    try {
      const settled = { ...record, metricsByContestant, finishByContestant };
      const outcome = await runJudgeOnce(settled, judgeDir).catch((error: unknown) => ({ diffStatsByContestant: record.diffStatsByContestant, checkByContestant: record.checkByContestant, panel: null, judgeError: `The judge failed: ${errorMessage(error)}.` }));
      const recall = await scoreRecall(settled, judgeDir).catch((error: unknown) => ({ recallByContestant: {}, failures: [`Recall scoring failed: ${errorMessage(error)}.`] }));
      const judgeError = [outcome.judgeError, ...recall.failures].filter((part): part is string => part !== null).join(' ') || null;
      await updateRecord(raceId, (current) => ({ ...current, ...outcome, judgeError, recallByContestant: recall.recallByContestant, metricsByContestant, finishByContestant, judge: null, phase: 'judged' }));
      log.log(`[race] judged ${record.spec.title}${outcome.judgeError ? `: ${outcome.judgeError}` : ''}`);
      await startNextRound(record);
    } finally {
      await fsp.rm(judgeDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function judge(raceId: string, finishesAtTrigger: RaceRecord['finishByContestant'] | null = null): Promise<{ ok: true } | { ok: false; error: string }> {
    const record = raceById.get(raceId);
    if (!record) return { ok: false, error: 'That race is not loaded.' };
    if (record.phase === 'judging') return { ok: false, error: 'The judge is already running for this race.' };
    if (!judgeRoot) return { ok: false, error: 'Judging is unavailable.' };
    await updateRecord(raceId, (current) => ({ ...current, phase: 'judging', judgeError: null }));
    void runJudge(raceId, finishesAtTrigger).catch((error: unknown) => log.warn(`[race] judging ${raceId} failed: ${errorMessage(error)}`));
    return { ok: true };
  }

  async function pickWinner(raceId: string, contestantId: string): Promise<{ ok: true; winnerSessionId: string; loserSessionIds: string[]; notes: string | null } | { ok: false; error: string }> {
    const record = raceById.get(raceId);
    if (!record) return { ok: false, error: 'That race is not loaded.' };
    if (record.winnerContestantId && record.winnerContestantId !== contestantId) return { ok: false, error: 'This race already has a different winner.' };
    const siblings = seriesRecords(record);
    if (siblings.some((sibling) => sibling.id !== record.id && sibling.winnerContestantId !== null)) return { ok: false, error: 'Another round of this race already has a winner.' };
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
    const loserSessionIds = siblings.flatMap((sibling) => Object.values(sibling.sessionIdByContestant)).filter((sessionId) => sessionId !== winnerSessionId);
    return { ok: true, winnerSessionId, loserSessionIds, notes: winnerNotesOf(record, contestantId) };
  }

  function judgeSettledRaces(): void {
    for (const record of raceById.values()) {
      if (record.phase !== 'running' || seriesRecords(record).some((round) => round.winnerContestantId !== null)) continue;
      const finishes = finishesNow(record);
      const isUndecided = Object.values(finishes).some((finish) => finish === null);
      if (Object.keys(finishes).length === 0 || isUndecided) continue;
      void judge(record.id, decidedFinishes(finishes));
    }
  }

  function startWatching(): void {
    if (settleTimer || isWatchingStopped) return;
    settleTimer = setInterval(judgeSettledRaces, SETTLE_CHECK_INTERVAL_MS);
    settleTimer.unref?.();
  }

  function stopWatching(): void {
    isWatchingStopped = true;
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

  async function listCases(): Promise<{ ok: true; cases: Awaited<ReturnType<ReviewCaseLibrary['list']>> } | { ok: false; error: string }> {
    if (!reviewCases) return { ok: false, error: 'The review case library is unavailable.' };
    return { ok: true, cases: await reviewCases.list() };
  }

  async function mineCases(repo: string): Promise<Awaited<ReturnType<ReviewCaseLibrary['mine']>>> {
    if (!reviewCases) return { ok: false, error: 'The review case library is unavailable.' };
    return reviewCases.mine(repo);
  }

  return { status, historyFrame, loadRaces, start, judge, pickWinner, startWatching, stopWatching, contestantDiffText, listCases, mineCases };
}

type RaceWiring = ReturnType<typeof createRaceWiring>;

export { createRaceWiring };
export type { RaceWiring };
