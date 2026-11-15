import type { CheckOutcome, ContestantMetrics, CriterionStanding, DiffStats, PanelStanding, RaceContestant, RaceCriterion, RaceRecord } from '#shared/contracts/race.ts';
import { RACE_CRITERIA } from '#shared/contracts/race.ts';
import { clockDurationText } from '#shared/display-text.ts';
import { recallStanding } from '#shared/race-core.ts';
import { MONITORING_ICON, STATE_ICONS } from '#shared/state-icons.ts';
import type { StatusIcon } from '#shared/state-icons.ts';
import { BADGE_LABELS, STATES } from '#shared/states.ts';
import type { SessionState } from '#shared/states.ts';

const MS_PER_MINUTE = 60_000;
const NO_VALUE = '-';

type RaceStage = 'running' | 'judging' | 'judged' | 'winner';

export interface LiveContestant {
  state: string;
  stateSince: number;
  taskTitle: string | null;
  isMonitoring: boolean;
}

type LiveOf = (contestantId: string) => LiveContestant | null;

const REMOVED_STATE = 'REMOVED';
const PAST_STATE = 'PAST';

const SETTLED_LIVE_STATES: ReadonlySet<string> = new Set([STATES.COMPLETE, STATES.DONE, STATES.FAILED]);

const CRITERION_LABELS: Readonly<Record<RaceCriterion, string>> = { correctness: 'Correct', completeness: 'Complete', scope: 'Scope', quality: 'Quality' };

export function durationText(elapsedMs: number): string {
  return clockDurationText(Math.max(0, elapsedMs), { rounding: 'floor', showsHours: true });
}

export function raceStage(race: RaceRecord): RaceStage {
  if (race.winnerContestantId !== null) return 'winner';
  return race.phase;
}

export function isScored(race: RaceRecord): boolean {
  return race.panel !== null || race.judge !== null || Object.keys(race.recallByContestant).length > 0;
}

function isSettledLive(live: LiveContestant | null): boolean {
  return live === null || SETTLED_LIVE_STATES.has(live.state);
}

function settledCount(race: RaceRecord, liveOf: LiveOf): { settled: number; total: number } {
  const ids = Object.keys(race.sessionIdByContestant);
  return { settled: ids.filter((id) => isSettledLive(liveOf(id))).length, total: ids.length };
}

function labelOf(race: RaceRecord, contestantId: string | null): string {
  return race.spec.contestants.find((contestant) => contestant.id === contestantId)?.label ?? contestantId ?? NO_VALUE;
}

function standingOf(race: RaceRecord, contestantId: string): PanelStanding | null {
  return race.panel?.standing.find((entry) => entry.contestantId === contestantId) ?? null;
}

export function rankOf(race: RaceRecord, contestantId: string): number | null {
  if (race.spec.reviewCase) {
    const recallRank = recallStanding(race).find((entry) => entry.contestantId === contestantId)?.rank;
    if (recallRank !== undefined) return recallRank;
  }
  return standingOf(race, contestantId)?.rank ?? race.judge?.ranking.find((entry) => entry.contestantId === contestantId)?.rank ?? null;
}

export function orderedContestants(race: RaceRecord): RaceContestant[] {
  const sortKey = (contestant: RaceContestant) => rankOf(race, contestant.id) ?? Number.MAX_SAFE_INTEGER;
  return [...race.spec.contestants].sort((left, right) => sortKey(left) - sortKey(right));
}

function topContestantId(race: RaceRecord): string | null {
  const top = orderedContestants(race)[0];
  return top && rankOf(race, top.id) !== null ? top.id : null;
}

interface RaceStep {
  key: RaceStage;
  label: string;
  status: 'done' | 'now' | 'next';
}

const STAGE_ORDER: readonly RaceStage[] = ['running', 'judging', 'judged', 'winner'];

export function stepsOf(race: RaceRecord, liveOf: LiveOf): RaceStep[] {
  const stage = raceStage(race);
  const nowIndex = STAGE_ORDER.indexOf(stage);
  const progress = settledCount(race, liveOf);
  const labels: Record<RaceStage, string> = {
    running: stage === 'running' ? `Running, ${progress.settled} of ${progress.total} settled` : 'Running',
    judging: 'Judging',
    judged: (stage === 'judged' || stage === 'winner' ? isScored(race) : race.spec.judges.length > 0 || race.spec.reviewCase !== null) ? 'Judged' : 'Finished',
    winner: stage === 'winner' ? `Winner ${labelOf(race, race.winnerContestantId)}` : 'Winner',
  };
  return STAGE_ORDER.map((key, index) => ({ key, label: labels[key], status: index < nowIndex ? 'done' : index === nowIndex ? 'now' : 'next' }));
}

function finishMs(race: RaceRecord, contestantId: string, live: LiveContestant | null): number | null {
  const recorded = race.metricsByContestant[contestantId]?.elapsedMs ?? null;
  if (recorded !== null) return recorded;
  if (live && SETTLED_LIVE_STATES.has(live.state)) return Math.max(0, live.stateSince - race.createdAt);
  return null;
}

function limitMs(race: RaceRecord): number | null {
  return race.spec.timeLimitMinutes === null ? null : race.spec.timeLimitMinutes * MS_PER_MINUTE;
}

function longestFinishMs(race: RaceRecord, liveOf: LiveOf): number | null {
  const finishes = race.spec.contestants.map((contestant) => finishMs(race, contestant.id, liveOf(contestant.id))).filter((value): value is number => value !== null);
  return finishes.length > 0 ? Math.max(...finishes) : null;
}

interface RaceClock {
  value: string;
  caption: string;
  limitFraction: number | null;
}

export function raceClock(race: RaceRecord, liveOf: LiveOf, nowMs: number): RaceClock {
  const stage = raceStage(race);
  const limit = limitMs(race);
  if (stage === 'running') {
    const elapsed = nowMs - race.createdAt;
    if (limit === null) return { value: durationText(elapsed), caption: 'No time limit', limitFraction: null };
    const left = limit - elapsed;
    const caption = left > 0 ? `${race.spec.timeLimitMinutes}m limit, ${durationText(left)} left` : `${race.spec.timeLimitMinutes}m limit reached`;
    return { value: durationText(elapsed), caption, limitFraction: Math.min(1, Math.max(0, elapsed / limit)) };
  }
  const longest = longestFinishMs(race, liveOf);
  const value = longest === null ? NO_VALUE : durationText(longest);
  if (stage === 'judging') return { value, caption: 'Judging', limitFraction: null };
  if (stage === 'winner') return { value, caption: `Winner ${labelOf(race, race.winnerContestantId)}`, limitFraction: null };
  const top = topContestantId(race);
  return { value, caption: top ? `First ${labelOf(race, top)}` : 'Finished, unranked', limitFraction: null };
}

export function trackAxisMs(race: RaceRecord, liveOf: LiveOf, nowMs: number): number {
  const candidates = [limitMs(race) ?? 0, longestFinishMs(race, liveOf) ?? 0];
  if (raceStage(race) === 'running') candidates.push(nowMs - race.createdAt);
  return Math.max(1, ...candidates);
}

interface RowTrack {
  fraction: number;
  isFinished: boolean;
}

export function rowTrack(race: RaceRecord, contestantId: string, live: LiveContestant | null, nowMs: number, axisMs: number): RowTrack {
  const finish = finishMs(race, contestantId, live);
  if (finish !== null) return { fraction: Math.min(1, finish / axisMs), isFinished: true };
  if (live && raceStage(race) === 'running') return { fraction: Math.min(1, (nowMs - race.createdAt) / axisMs), isFinished: false };
  return { fraction: 0, isFinished: false };
}

interface RowStatus {
  stateKey: string;
  icon: StatusIcon;
  label: string;
}

function badgeLabel(state: string): string {
  return Object.entries(BADGE_LABELS).find(([badgeState]) => badgeState === state)?.[1] ?? state;
}

function iconOfState(state: string): StatusIcon {
  return Object.entries(STATE_ICONS).find(([iconState]) => iconState === state)?.[1] ?? 'exited';
}

export function rowStatus(race: RaceRecord, contestantId: string, live: LiveContestant | null, isPast: boolean): RowStatus {
  const finish = race.finishByContestant[contestantId];
  if (finish?.status === 'did-not-finish' && (isPast || raceStage(race) !== 'running')) return { stateKey: STATES.FAILED, icon: 'failed', label: 'Did not finish' };
  if (isPast) return { stateKey: PAST_STATE, icon: 'complete', label: 'Finished' };
  if (!live) return { stateKey: REMOVED_STATE, icon: 'exited', label: 'Removed' };
  if (live.state === STATES.RUNNING && live.isMonitoring) return { stateKey: live.state, icon: MONITORING_ICON, label: 'Monitoring' };
  if (live.state === STATES.COMPLETE) return { stateKey: live.state, icon: 'complete', label: 'Finished' };
  return { stateKey: live.state, icon: iconOfState(live.state), label: badgeLabel(live.state as SessionState) };
}

export function rowTimeText(race: RaceRecord, contestantId: string, live: LiveContestant | null, nowMs: number): string {
  const finish = finishMs(race, contestantId, live);
  if (finish !== null) return durationText(finish);
  if (live && raceStage(race) === 'running') return durationText(nowMs - race.createdAt);
  return NO_VALUE;
}

export function rowDoing(race: RaceRecord, contestantId: string, live: LiveContestant | null, nowMs: number): string {
  const finish = race.finishByContestant[contestantId];
  if (finish?.status === 'did-not-finish') return `Did not finish: ${finish.reason ?? 'no reason given'}`;
  const stage = raceStage(race);
  if (stage === 'judged' || stage === 'winner') {
    const summary = standingOf(race, contestantId)?.summary ?? race.judge?.ranking.find((entry) => entry.contestantId === contestantId)?.reason ?? null;
    if (summary) return summary;
    if (isScored(race) && rankOf(race, contestantId) === null) return 'Not ranked: changed nothing the judges could read';
  }
  if (live?.state === STATES.WAITING) return `Needs input for ${durationText(nowMs - live.stateSince)}${live.taskTitle ? `: ${live.taskTitle}` : ''}`;
  if (live?.taskTitle) return live.taskTitle;
  if (!live) return stage === 'running' ? 'Session removed' : '';
  if (live.state === STATES.STARTING || live.state === STATES.INITIALIZING) return 'Preparing its worktree';
  return '';
}

export function setupCaption(contestant: RaceContestant): string {
  const parts = [contestant.home === 'clean' ? 'clean home' : null, contestant.setup.instructions.trim() === '' ? null : `instructions: ${contestant.setup.instructions.trim()}`];
  return parts.filter((part): part is string => part !== null).join(', ');
}

interface CellText {
  value: string;
  caption: string;
}

function checkText(check: CheckOutcome): string {
  if (check.status === 'passed') return 'check passed';
  if (check.status === 'failed') return `check failed, ${check.exitCode === null ? (check.reason ?? 'stopped') : `exit ${check.exitCode}`}`;
  return 'check could not run';
}

export function diffCell(stats: DiffStats | undefined, check: CheckOutcome | undefined, hasCheckColumn: boolean): CellText {
  const checkPart = check && !hasCheckColumn ? checkText(check) : null;
  if (!stats) return { value: NO_VALUE, caption: checkPart ?? '' };
  const filesPart = stats.filesChanged === 1 ? '1 file' : `${stats.filesChanged} files`;
  return { value: `+${stats.linesAdded} -${stats.linesRemoved}`, caption: [filesPart, checkPart].filter(Boolean).join(', ') };
}

function tokensText(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k tokens` : `${tokens} tokens`;
}

export function costCell(metrics: ContestantMetrics | undefined): CellText {
  if (!metrics) return { value: NO_VALUE, caption: '' };
  const waits = metrics.waits === 0 ? null : metrics.waits === 1 ? '1 wait' : `${metrics.waits} waits`;
  return {
    value: metrics.costUSD === null ? NO_VALUE : `$${metrics.costUSD.toFixed(2)}`,
    caption: [metrics.tokens === null ? null : tokensText(metrics.tokens), waits].filter(Boolean).join(', '),
  };
}

export function rankText(race: RaceRecord, contestantId: string): string {
  const rank = rankOf(race, contestantId);
  return rank === null ? '' : `#${rank}`;
}

export type ScoreArea =
  | { kind: 'track' }
  | { kind: 'criteria'; cells: { key: string; label: string; standing: CriterionStanding | 'none' }[] }
  | { kind: 'recall'; fraction: number; text: string }
  | { kind: 'note'; text: string };

export function scoreArea(race: RaceRecord, contestantId: string): ScoreArea {
  const stage = raceStage(race);
  if (stage === 'running' || stage === 'judging') return { kind: 'track' };
  const recall = race.recallByContestant[contestantId];
  if (recall !== undefined) return { kind: 'recall', fraction: recall, text: `recall ${Math.round(recall * 100)}%` };
  const standing = standingOf(race, contestantId);
  if (standing) {
    const cells: { key: string; label: string; standing: CriterionStanding | 'none' }[] = RACE_CRITERIA.map((criterion) => ({ key: criterion, label: CRITERION_LABELS[criterion], standing: standing.criteria[criterion] }));
    if (race.spec.check) cells.push({ key: 'check', label: 'Check', standing: checkStanding(race.checkByContestant[contestantId]) });
    return { kind: 'criteria', cells };
  }
  if (isScored(race)) return { kind: 'note', text: 'not ranked' };
  return { kind: 'track' };
}

function checkStanding(check: CheckOutcome | undefined): CriterionStanding | 'none' {
  if (check?.status === 'passed') return 'pass';
  if (check?.status === 'failed') return 'fail';
  return 'none';
}

export function hasCheckColumn(race: RaceRecord): boolean {
  return scoreHeadings(race).includes('Check');
}

export function scoreHeadings(race: RaceRecord): string[] {
  const stage = raceStage(race);
  if ((stage === 'judged' || stage === 'winner') && race.panel !== null && !race.spec.reviewCase) return [...RACE_CRITERIA.map((criterion) => CRITERION_LABELS[criterion]), ...(race.spec.check ? ['Check'] : [])];
  if ((stage === 'judged' || stage === 'winner') && race.spec.reviewCase) return ['Recall'];
  return ['Progress'];
}

export interface RowActions {
  canOpen: boolean;
  detailsLabel: 'Diff' | 'Details' | null;
  pick: 'primary' | 'secondary' | null;
}

export function rowActions(race: RaceRecord, contestantId: string, live: LiveContestant | null, isPast: boolean): RowActions {
  const stage = raceStage(race);
  const isDecided = stage === 'judged' || stage === 'winner';
  const hasNotes = standingOf(race, contestantId) !== null || (race.judge?.notes[contestantId] ?? '') !== '' || race.checkByContestant[contestantId] !== undefined;
  const detailsLabel = isDecided && (hasNotes || live) ? 'Details' : live ? 'Diff' : null;
  if (isPast) return { canOpen: false, detailsLabel: hasNotes ? 'Details' : null, pick: null };
  const canPick = stage === 'judged' && live !== null && (!isScored(race) || rankOf(race, contestantId) !== null);
  return { canOpen: live !== null && !isDecided, detailsLabel, pick: canPick ? (topContestantId(race) === contestantId ? 'primary' : 'secondary') : null };
}

export function footHint(race: RaceRecord, liveOf: LiveOf): string {
  const stage = raceStage(race);
  const hasJudges = race.spec.judges.length > 0 || race.spec.reviewCase !== null;
  if (stage === 'running') return hasJudges ? 'Judging starts once every contestant settles.' : 'No judges. Once every contestant settles, compare the diffs and pick a winner.';
  if (stage === 'judging') return race.spec.reviewCase ? 'A blinded matcher scores each contestant against the reviewers\' comments.' : 'Judges see each change under a letter in a new random order, never the contestant\'s name.';
  if (stage === 'winner') return `${labelOf(race, race.winnerContestantId)} stays an ordinary session.`;
  const progress = settledCount(race, liveOf);
  return progress.total > 0 ? 'Picking a winner keeps it as an ordinary session and removes the others with their worktrees, after you confirm.' : '';
}

export function unsettledCount(race: RaceRecord, liveOf: LiveOf): number {
  const progress = settledCount(race, liveOf);
  return progress.total - progress.settled;
}

interface PatchFile {
  path: string;
  patch: string;
  added: number;
  removed: number;
}

function pathOfPatch(patch: string): string {
  const target = /^\+\+\+ b\/(.+)$/m.exec(patch)?.[1];
  if (target) return target;
  const source = /^--- a\/(.+)$/m.exec(patch)?.[1];
  if (source) return source;
  return /^diff --git a\/(.+?) b\//.exec(patch)?.[1] ?? 'file';
}

export function splitUnifiedDiff(text: string): PatchFile[] {
  const starts = [...text.matchAll(/^diff --git /gm)].map((match) => match.index);
  return starts.map((start, index) => {
    const patch = text.slice(start, starts[index + 1] ?? text.length);
    const lines = patch.split('\n');
    const hunkStart = lines.findIndex((line) => line.startsWith('@@'));
    const body = hunkStart === -1 ? [] : lines.slice(hunkStart);
    return {
      path: pathOfPatch(patch),
      patch,
      added: body.filter((line) => line.startsWith('+')).length,
      removed: body.filter((line) => line.startsWith('-')).length,
    };
  });
}

export function raceMeta(race: RaceRecord, formatDateTime: (ms: number) => string): string {
  const parts = [
    `${race.baseBranch} at ${race.startSha.slice(0, 8)}`,
    race.series ? `round ${race.series.round} of ${race.spec.rounds}` : null,
    `started ${formatDateTime(race.createdAt)}`,
    race.spec.reviewCase ? 'ranked by recall' : race.spec.judges.length === 0 ? 'no judges' : race.spec.judges.length === 1 ? '1 judge' : `${race.spec.judges.length} judges`,
    race.panel && race.panel.firstPlaceAgreement.judges > 1 ? `judges agree on first place ${race.panel.firstPlaceAgreement.agreeing} of ${race.panel.firstPlaceAgreement.judges}` : null,
  ];
  return parts.filter((part): part is string => part !== null).join(', ');
}
