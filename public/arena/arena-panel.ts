import { AgentModelCatalog } from '#shared/contracts/agent-models.ts';
import type { AgentSetup } from '#shared/contracts/agent-models.ts';
import type { CheckOutcome, ContestantMetrics, PanelStanding, RaceCheck, RaceContestant, RaceRecord } from '#shared/contracts/race.ts';
import { RACE_CRITERIA, RACE_JUDGE_AGENT, RACE_MAX_CONTESTANTS, RACE_MAX_JUDGES, RACE_MAX_ROUNDS, RaceSpec } from '#shared/contracts/race.ts';
import { REMOVED_CONTESTANT, raceProgress, seriesKey, seriesStanding, winnerNotesOf } from '#shared/race-core.ts';
import { BADGE_LABELS } from '#shared/states.ts';
import { benchmarkSnapshot, subscribeBenchmarks } from '../benchmark-store.ts';
import { sendControlRequest } from '../control-ws.ts';
import './arena-panel.css';
import { el } from '../dom-helpers.ts';
import { isPhoneLayout } from '../form-factor.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { onSessionTick } from '../session-card/session-tick.ts';
import { button } from '../ui/button.ts';
import { buildDialogShell } from '../session-card/modal.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { agentLabel, agentsWithModels, contestantsFor, defaultSetup, effortOf, effortsOf, modelsOf, VARY_SETTINGS, varyChoices, varyLineup, withEffortChoice, withModel } from './lineup-core.ts';
import type { VarySetting } from './lineup-core.ts';
import { openRaceSession, raceList, subscribeRaces } from './race-store.ts';

const START_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 60_000;
const SHORT_SHA_LENGTH = 8;

interface RaceDraft {
  raceTitle: string;
  prompt: string;
  repoPath: string;
  contestants: RaceContestant[];
  judges: AgentSetup[];
  check: RaceCheck | null;
  checkTimeoutSeconds: number;
  timeLimitMinutes: number | null;
  rounds: number;
}

const DEFAULT_CHECK_TIMEOUT_SECONDS = 600;

let root: HTMLElement | null = null;
let racesEl: HTMLElement | null = null;
let catalog: AgentModelCatalog = { agents: [] };
let draft: RaceDraft = { raceTitle: '', prompt: '', repoPath: '', contestants: [], judges: [], check: null, checkTimeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS, timeLimitMinutes: null, rounds: 1 };
let hasDefaultJudge = false;
let isEditingAsFile = false;
const shownDiffByKey = new Map<string, string>();
const shownCheckOutputKeys = new Set<string>();
const judgeStatusByRace = new Map<string, string>();

function stateLabel(state: string): string {
  return Object.entries(BADGE_LABELS).find(([badgeState]) => badgeState === state)?.[1] ?? state;
}

function contestantState(sessionId: string | undefined): string {
  const ui = sessionId ? sessionUIs.get(sessionId) : undefined;
  return ui ? ui.currentState : REMOVED_CONTESTANT;
}

function diffKey(raceId: string, contestantId: string): string {
  return `${raceId}:${contestantId}`;
}

function requestDiff(race: RaceRecord, contestant: RaceContestant): void {
  const key = diffKey(race.id, contestant.id);
  if (shownDiffByKey.has(key)) {
    shownDiffByKey.delete(key);
    renderRaces();
    return;
  }
  shownDiffByKey.set(key, 'Loading the diff.');
  renderRaces();
  sendControlRequest('race-diff', { raceId: race.id, contestantId: contestant.id }, { timeoutMs: REQUEST_TIMEOUT_MS })
    .then((reply) => {
      if (reply.type !== 'race-diff-result') return;
      shownDiffByKey.set(key, reply.ok ? (reply.diff || 'No changes.') : `Could not read the diff: ${reply.error ?? 'unknown error'}`);
    })
    .catch((reason: unknown) => shownDiffByKey.set(key, `Could not read the diff: ${reason instanceof Error ? reason.message : String(reason)}`))
    .finally(renderRaces);
}

function checkText(check: CheckOutcome): string {
  if (check.status === 'passed') return 'Check passed';
  if (check.status === 'failed') return `Check failed, ${check.exitCode === null ? check.reason : `exit ${check.exitCode}`}`;
  return `Check could not run: ${check.reason}`;
}

function elapsedText(elapsedMs: number): string {
  const totalSeconds = Math.round(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return minutes > 0 ? `${minutes}m ${totalSeconds % 60}s` : `${totalSeconds}s`;
}

function tokensText(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k tokens` : `${tokens} tokens`;
}

function metricsText(metrics: ContestantMetrics): string {
  return [
    metrics.elapsedMs === null ? 'not settled' : elapsedText(metrics.elapsedMs),
    metrics.costUSD === null ? null : `$${metrics.costUSD.toFixed(2)}`,
    metrics.tokens === null ? null : tokensText(metrics.tokens),
    metrics.waits === 1 ? '1 wait' : `${metrics.waits} waits`,
  ].filter((part): part is string => part !== null).join(', ');
}

function toggleCheckOutput(key: string): void {
  if (!shownCheckOutputKeys.delete(key)) shownCheckOutputKeys.add(key);
  renderRaces();
}

const CRITERION_LABELS: Readonly<Record<(typeof RACE_CRITERIA)[number], string>> = { correctness: 'correct', completeness: 'complete', scope: 'scope', quality: 'quality' };

function standingOf(race: RaceRecord, contestantId: string): PanelStanding | null {
  return race.panel?.standing.find((entry) => entry.contestantId === contestantId) ?? null;
}

function rankOf(race: RaceRecord, contestantId: string): number | null {
  return standingOf(race, contestantId)?.rank ?? race.judge?.ranking.find((entry) => entry.contestantId === contestantId)?.rank ?? null;
}

function buildCriteriaLine(standing: PanelStanding): HTMLElement {
  const line = el('div', 'arena-criteria');
  for (const criterion of RACE_CRITERIA) line.append(el('span', `arena-criterion arena-criterion-${standing.criteria[criterion]}`, `${CRITERION_LABELS[criterion]} ${standing.criteria[criterion]}`));
  return line;
}

function buildContestantLine(race: RaceRecord, contestant: RaceContestant): HTMLElement {
  const line = el('li', 'arena-contestant');
  const sessionId = race.sessionIdByContestant[contestant.id];
  const state = contestantState(sessionId);
  const rank = rankOf(race, contestant.id);
  const standing = standingOf(race, contestant.id);
  const legacyReason = race.judge?.ranking.find((entry) => entry.contestantId === contestant.id)?.reason ?? null;
  const stats = race.diffStatsByContestant[contestant.id];
  const head = el('div', 'arena-contestant-head');
  head.append(el('span', 'arena-contestant-rank', rank === null ? '-' : `#${rank}`));
  head.append(el('span', 'arena-contestant-label', contestant.label));
  if (standing) head.append(el('span', 'arena-contestant-score', `${standing.criteriaPassed} of ${RACE_CRITERIA.length}`));
  head.append(el('span', 'arena-contestant-state', state === REMOVED_CONTESTANT ? 'Removed' : stateLabel(state)));
  if (stats) head.append(el('span', 'arena-contestant-stats', `+${stats.linesAdded} -${stats.linesRemoved}, ${stats.filesChanged} files`));
  const finish = race.finishByContestant[contestant.id];
  if (finish?.status === 'did-not-finish') head.append(el('span', 'arena-contestant-check arena-contestant-check-failed', `Did not finish: ${finish.reason ?? 'no reason given'}`));
  const check = race.checkByContestant[contestant.id];
  if (check) head.append(el('span', `arena-contestant-check arena-contestant-check-${check.status}`, checkText(check)));
  const metrics = race.metricsByContestant[contestant.id];
  if (metrics) head.append(el('span', 'arena-contestant-stats', metricsText(metrics)));
  if (race.winnerContestantId === contestant.id) head.append(el('span', 'arena-contestant-winner', 'Winner'));
  if (sessionId && state !== REMOVED_CONTESTANT) {
    head.append(button({ variant: 'quiet', size: 'small', label: 'Open', onClick: () => openRaceSession(sessionId) }));
    const canPick = race.winnerContestantId === null || race.winnerContestantId === contestant.id;
    if (canPick) head.append(button({ variant: 'quiet', size: 'small', label: 'Pick winner', onClick: () => openPickWinnerDialog(race, contestant) }));
    const diffButton = button({ variant: 'quiet', size: 'small', label: 'Show diff', onClick: () => requestDiff(race, contestant) });
    diffButton.setAttribute('aria-expanded', String(shownDiffByKey.has(diffKey(race.id, contestant.id))));
    head.append(diffButton);
  }
  if (check?.outputTail) {
    const outputButton = button({ variant: 'quiet', size: 'small', label: 'Show check output', onClick: () => toggleCheckOutput(diffKey(race.id, contestant.id)) });
    outputButton.setAttribute('aria-expanded', String(shownCheckOutputKeys.has(diffKey(race.id, contestant.id))));
    head.append(outputButton);
  }
  line.append(head);
  if (standing) line.append(buildCriteriaLine(standing));
  if (standing?.summary) line.append(el('p', 'arena-contestant-reason', `Judges: ${standing.summary}`));
  if (legacyReason) line.append(el('p', 'arena-contestant-reason', legacyReason));
  if (check && shownCheckOutputKeys.has(diffKey(race.id, contestant.id))) line.append(el('pre', 'arena-diff', check.outputTail));
  const shownDiff = shownDiffByKey.get(diffKey(race.id, contestant.id));
  if (shownDiff !== undefined) line.append(el('pre', 'arena-diff', shownDiff));
  return line;
}

function openPickWinnerDialog(race: RaceRecord, winner: RaceContestant): void {
  const { dialog, close, actions, btnCancel } = buildDialogShell({ title: `Pick ${winner.label} as the winner` });
  const losers = race.spec.contestants.filter((contestant) => contestant.id !== winner.id && contestantState(race.sessionIdByContestant[contestant.id]) !== REMOVED_CONTESTANT);
  const loserText = losers.length > 0
    ? `${losers.map((contestant) => contestant.label).join(', ')} will be stopped and removed with their worktrees and branches, without pushing. ${winner.label} stays an ordinary session.`
    : `${winner.label} stays an ordinary session. No other contestant is left to remove.`;
  dialog.append(el('p', 'dialog-message', loserText));
  const notes = winnerNotesOf(race, winner.id);
  const notesBox = el('input');
  notesBox.type = 'checkbox';
  if (notes) {
    const notesField = el('label', 'dialog-checkbox-label');
    notesField.append(notesBox, el('span', null, "Also send it the judges' notes"));
    dialog.append(notesField, el('pre', 'arena-diff', notes));
  }
  const confirm = button({ variant: 'danger', label: 'Pick winner', onClick: () => {
    close();
    pickWinner(race, winner, notes !== null && notesBox.checked);
  } });
  actions.append(confirm);
  dialog.append(actions);
  btnCancel.addEventListener('click', close);
}

function pickWinner(race: RaceRecord, winner: RaceContestant, sendNotes: boolean): void {
  judgeStatusByRace.set(race.id, `Picking ${winner.label}.`);
  renderRaces();
  sendControlRequest('race-pick-winner', { raceId: race.id, contestantId: winner.id, sendNotes }, { timeoutMs: START_TIMEOUT_MS })
    .then((reply) => {
      if (reply.type !== 'race-pick-winner-result') return;
      judgeStatusByRace.set(race.id, reply.ok ? '' : `Picked ${winner.label} with problems: ${reply.error ?? 'unknown error'}`);
    })
    .catch((reason: unknown) => judgeStatusByRace.set(race.id, `Could not pick the winner: ${reason instanceof Error ? reason.message : String(reason)}`))
    .finally(renderRaces);
}

function judgeRace(race: RaceRecord): void {
  judgeStatusByRace.set(race.id, 'Asking the judge.');
  renderRaces();
  sendControlRequest('race-judge', { raceId: race.id }, { timeoutMs: REQUEST_TIMEOUT_MS })
    .then((reply) => {
      if (reply.type !== 'race-judge-result') return;
      judgeStatusByRace.set(race.id, reply.ok ? '' : `Could not judge: ${reply.error ?? 'unknown error'}`);
    })
    .catch((reason: unknown) => judgeStatusByRace.set(race.id, `Could not judge: ${reason instanceof Error ? reason.message : String(reason)}`))
    .finally(renderRaces);
}

function phaseText(race: RaceRecord): string {
  const progress = raceProgress(Object.values(race.sessionIdByContestant), (sessionId) => contestantState(sessionId));
  if (race.winnerContestantId) return `Winner: ${race.spec.contestants.find((contestant) => contestant.id === race.winnerContestantId)?.label ?? race.winnerContestantId}.`;
  if (race.phase === 'judging') return 'Judging.';
  if (race.phase === 'judged') return [race.panel || race.judge ? 'Judged.' : 'Finished.', race.judgeError].filter(Boolean).join(' ');
  return `${progress.settled} of ${progress.total} settled.`;
}

function rankedContestants(race: RaceRecord): RaceContestant[] {
  const sortKey = (contestant: RaceContestant) => rankOf(race, contestant.id) ?? Number.MAX_SAFE_INTEGER;
  return [...race.spec.contestants].sort((left, right) => sortKey(left) - sortKey(right));
}

function buildPanelSummary(race: RaceRecord): HTMLElement | null {
  const panel = race.panel;
  if (!panel) return null;
  const summary = el('div', 'arena-panel-summary');
  summary.append(el('span', 'arena-status', `Judges agree on first place: ${panel.firstPlaceAgreement.agreeing} of ${panel.firstPlaceAgreement.judges}.`));
  for (const failure of panel.failures) summary.append(el('span', 'arena-status arena-judge-failure', `Judge ${failure.label} failed: ${failure.reason}`));
  return summary;
}

function buildRace(race: RaceRecord): HTMLElement {
  const item = el('article', 'arena-race');
  item.append(el('h3', 'arena-race-title', race.spec.title));
  const roundText = race.series ? `, round ${race.series.round} of ${race.spec.rounds}` : '';
  item.append(el('p', 'arena-race-meta', `${race.baseBranch} at ${race.startSha.slice(0, SHORT_SHA_LENGTH)}, ${new Date(race.createdAt).toLocaleString()}${roundText}`));
  const actions = el('div', 'arena-race-actions');
  const judgeButton = button({ variant: 'secondary', size: 'small', label: 'Judge now', disabled: race.phase === 'judging', onClick: () => judgeRace(race) });
  const statusEl = el('span', 'arena-status', judgeStatusByRace.get(race.id) || phaseText(race));
  statusEl.setAttribute('role', 'status');
  actions.append(judgeButton, statusEl);
  item.append(actions);
  const panelSummary = buildPanelSummary(race);
  if (panelSummary) item.append(panelSummary);
  const lineup = el('ul', 'arena-contestants');
  for (const contestant of rankedContestants(race)) lineup.append(buildContestantLine(race, contestant));
  item.append(lineup);
  const seriesSummary = buildSeriesSummary(race);
  if (seriesSummary) item.append(seriesSummary);
  return item;
}

function buildSeriesSummary(race: RaceRecord): HTMLElement | null {
  if (!race.series) return null;
  const rounds = raceList().filter((candidate) => seriesKey(candidate) === seriesKey(race));
  const latestRound = Math.max(...rounds.map((round) => round.series?.round ?? 1));
  if (race.series.round !== latestRound) return null;
  const labelById = new Map(race.spec.contestants.map((contestant) => [contestant.id, contestant.label]));
  const parts = seriesStanding(rounds).map((standing) => {
    const spread = standing.lowestScore === null ? 'no scores' : `scores ${standing.lowestScore} to ${standing.highestScore}`;
    return `${labelById.get(standing.contestantId) ?? standing.contestantId} ${standing.wins} of ${standing.roundsJudged} (${spread})`;
  });
  return el('p', 'arena-panel-summary', `Series wins: ${parts.join(', ')}`);
}

function renderRaces(): void {
  if (!racesEl) return;
  const races = raceList();
  racesEl.replaceChildren(el('h2', 'arena-section-title', 'Races'));
  if (races.length === 0) {
    racesEl.append(el('p', 'arena-empty', 'No races yet.'));
    return;
  }
  for (const race of races) racesEl.append(buildRace(race));
}

function buildSelect(choices: readonly { value: string; label: string }[], selected: string | null, onChange: (value: string) => void, ariaLabel: string): HTMLSelectElement {
  const select = el('select', 'settings-view-input arena-select');
  select.setAttribute('aria-label', ariaLabel);
  for (const choice of choices) {
    const option = el('option', null, choice.label);
    option.value = choice.value;
    option.selected = choice.value === selected;
    select.append(option);
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function setupControls(setup: AgentSetup, onChange: (next: AgentSetup) => void, allowedAgents: readonly string[] | null = null): HTMLElement {
  const controls = el('div', 'arena-setup');
  const agentChoices = agentsWithModels(catalog).filter((agent) => !allowedAgents || allowedAgents.includes(agent)).map((agent) => ({ value: agent, label: agentLabel(agent) }));
  controls.append(buildSelect(agentChoices, setup.agent, (agent) => onChange({ ...defaultSetup(catalog, agent), instructions: setup.instructions }), 'Agent'));
  const modelChoices = modelsOf(catalog, setup.agent).map((model) => ({ value: model.id, label: model.label }));
  controls.append(buildSelect(modelChoices, setup.model, (modelId) => onChange(withModel(catalog, setup, modelId)), 'Model'));
  const efforts = effortsOf(catalog, setup.agent, setup.model);
  if (efforts.length > 0) controls.append(buildSelect(efforts.map((effort) => ({ value: effort, label: effort })), effortOf(setup), (effort) => onChange(withEffortChoice(setup, effort)), 'Effort'));
  return controls;
}

function draftSpec(): Record<string, unknown> {
  return {
    version: 1,
    title: draft.raceTitle,
    prompt: draft.prompt,
    repoPath: draft.repoPath,
    contestants: draft.contestants,
    judges: draft.judges.map((setup) => ({ setup })),
    check: draft.check,
    timeLimitMinutes: draft.timeLimitMinutes,
    rounds: draft.rounds,
  };
}

function parseCheckCommand(text: string): RaceCheck | null {
  const [program, ...args] = text.trim().split(/\s+/).filter(Boolean);
  if (!program) return null;
  return { program, args, timeoutSeconds: draft.checkTimeoutSeconds };
}

function buildCheckField(): HTMLElement {
  const field = el('div', 'arena-check');
  const command = textField('Check command, run in each checkout once it finishes', draft.check ? [draft.check.program, ...draft.check.args].join(' ') : '', (value) => { draft.check = parseCheckCommand(value); });
  command.querySelector('input')?.setAttribute('placeholder', 'npm test');
  const timeout = el('label', 'arena-field');
  timeout.append(el('span', 'arena-field-label', 'Check time limit in seconds'));
  const timeoutInput = el('input', 'settings-view-input');
  timeoutInput.type = 'number';
  timeoutInput.min = '5';
  timeoutInput.max = '3600';
  timeoutInput.value = String(draft.checkTimeoutSeconds);
  timeoutInput.addEventListener('input', () => {
    draft.checkTimeoutSeconds = Number(timeoutInput.value) || DEFAULT_CHECK_TIMEOUT_SECONDS;
    if (draft.check) draft.check = { ...draft.check, timeoutSeconds: draft.checkTimeoutSeconds };
  });
  timeout.append(timeoutInput);
  field.append(command, timeout);
  return field;
}

function buildTimeLimitField(): HTMLElement {
  const field = el('label', 'arena-field');
  field.append(el('span', 'arena-field-label', 'Time limit in minutes, empty for none'));
  const input = el('input', 'settings-view-input');
  input.type = 'number';
  input.min = '1';
  input.max = '720';
  input.value = draft.timeLimitMinutes === null ? '' : String(draft.timeLimitMinutes);
  input.addEventListener('input', () => {
    const minutes = Number(input.value);
    draft.timeLimitMinutes = input.value.trim() === '' || !Number.isInteger(minutes) || minutes < 1 ? null : Math.min(minutes, 720);
  });
  field.append(input);
  return field;
}

function buildRoundsField(): HTMLElement {
  const field = el('label', 'arena-field');
  field.append(el('span', 'arena-field-label', `Rounds, 1 to ${RACE_MAX_ROUNDS}, run one after another`));
  const input = el('input', 'settings-view-input');
  input.type = 'number';
  input.min = '1';
  input.max = String(RACE_MAX_ROUNDS);
  input.value = String(draft.rounds);
  input.addEventListener('input', () => {
    const rounds = Number(input.value);
    draft.rounds = Number.isInteger(rounds) ? Math.min(Math.max(rounds, 1), RACE_MAX_ROUNDS) : 1;
  });
  field.append(input);
  return field;
}

function textField(label: string, value: string, onInput: (value: string) => void, isMultiline = false): HTMLElement {
  const field = el('label', 'arena-field');
  field.append(el('span', 'arena-field-label', label));
  const input = isMultiline ? el('textarea', 'settings-view-input arena-prompt') : el('input', 'settings-view-input');
  input.value = value;
  input.addEventListener('input', () => onInput(input.value));
  field.append(input);
  return field;
}

function relabel(contestants: RaceContestant[]): RaceContestant[] {
  return contestantsFor(catalog, contestants.map((contestant) => contestant.setup));
}

function buildLineupEditor(onChanged: () => void): HTMLElement {
  const lineup = el('div', 'arena-lineup');
  draft.contestants.forEach((contestant, index) => {
    const column = el('div', 'arena-column');
    column.append(el('span', 'arena-column-label', contestant.label));
    column.append(setupControls(contestant.setup, (next) => {
      draft.contestants = relabel(draft.contestants.map((existing, position) => (position === index ? { ...existing, setup: next } : existing)));
      onChanged();
    }));
    const instructions = el('textarea', 'settings-view-input');
    instructions.placeholder = 'Extra instructions for this contestant';
    instructions.rows = 3;
    instructions.value = contestant.setup.instructions;
    instructions.addEventListener('input', () => {
      draft.contestants = draft.contestants.map((existing, position) => (position === index ? { ...existing, setup: { ...existing.setup, instructions: instructions.value } } : existing));
    });
    column.append(instructions);
    column.append(button({ variant: 'quiet', size: 'small', label: 'Remove', onClick: () => {
      draft.contestants = relabel(draft.contestants.filter((_existing, position) => position !== index));
      onChanged();
    } }));
    lineup.append(column);
  });
  return lineup;
}

function buildJudgesEditor(onChanged: () => void): HTMLElement {
  const judges = el('div', 'arena-judges');
  judges.append(el('span', 'arena-field-label', draft.judges.length === 0 ? 'Judges: none, the race is not judged' : `Judges: ${draft.judges.length} of ${RACE_MAX_JUDGES}`));
  draft.judges.forEach((judge, index) => {
    const row = el('div', 'arena-judge');
    row.append(setupControls(judge, (next) => {
      draft.judges = draft.judges.map((existing, position) => (position === index ? next : existing));
      onChanged();
    }, [RACE_JUDGE_AGENT]));
    row.append(button({ variant: 'quiet', size: 'small', label: 'Remove', onClick: () => {
      draft.judges = draft.judges.filter((_existing, position) => position !== index);
      onChanged();
    } }));
    judges.append(row);
  });
  judges.append(button({ variant: 'quiet', size: 'small', label: 'Add judge', disabled: draft.judges.length >= RACE_MAX_JUDGES, onClick: () => {
    draft.judges = [...draft.judges, draft.judges.at(-1) ?? defaultSetup(catalog, RACE_JUDGE_AGENT)];
    onChanged();
  } }));
  return judges;
}

function buildVaryBuilder(onChanged: () => void): HTMLElement {
  const builder = el('div', 'arena-vary');
  let base = draft.contestants[0]?.setup ?? defaultSetup(catalog, agentsWithModels(catalog)[0] ?? 'claude-code');
  let setting: VarySetting = 'model';
  const choicesEl = el('div', 'arena-vary-choices');
  const paintChoices = () => {
    choicesEl.replaceChildren();
    for (const choice of varyChoices(catalog, base, setting)) {
      const option = el('label', 'dialog-checkbox-label');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.value = choice.value;
      option.append(checkbox, el('span', null, choice.label));
      choicesEl.append(option);
    }
  };
  const baseEl = el('div', 'arena-vary-base');
  const paintBase = () => {
    baseEl.replaceChildren(setupControls(base, (next) => { base = next; paintBase(); paintChoices(); }));
  };
  builder.append(el('span', 'arena-field-label', 'Start from'), baseEl);
  builder.append(el('span', 'arena-field-label', 'Vary'), buildSelect(VARY_SETTINGS.map((value) => ({ value, label: value })), setting, (value) => {
    setting = VARY_SETTINGS.find((candidate) => candidate === value) ?? 'model';
    paintChoices();
  }, 'Setting to vary'));
  builder.append(choicesEl);
  builder.append(button({ variant: 'secondary', size: 'small', label: 'Use these', onClick: () => {
    const values = [...choicesEl.querySelectorAll('input:checked')].map((input) => (input instanceof HTMLInputElement ? input.value : '')).filter(Boolean);
    draft.contestants = varyLineup(catalog, base, setting, values);
    onChanged();
  } }));
  paintBase();
  paintChoices();
  return builder;
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readDraftFromFile(text: string): string | null {
  const parsed = RaceSpec.safeParse(parseJsonText(text));
  if (!parsed.success) return `The race file is not valid: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'file'}: ${issue.message}`).join('; ')}`;
  const spec = parsed.data;
  draft = { raceTitle: spec.title, prompt: spec.prompt, repoPath: spec.repoPath, contestants: spec.contestants, judges: spec.judges.map((judge) => judge.setup), check: spec.check, checkTimeoutSeconds: spec.check?.timeoutSeconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS, timeLimitMinutes: spec.timeLimitMinutes, rounds: spec.rounds };
  hasDefaultJudge = true;
  return null;
}

function buildNewRace(): HTMLElement {
  const section = el('section', 'arena-new');
  const body = el('div', 'arena-new-body');
  const statusEl = el('span', 'arena-status');
  statusEl.setAttribute('role', 'status');
  const fileText = el('textarea', 'settings-view-input arena-file');
  fileText.setAttribute('aria-label', 'Race spec JSON');
  const paint = () => {
    body.replaceChildren();
    fileText.hidden = !isEditingAsFile;
    if (isEditingAsFile) {
      fileText.value = JSON.stringify(draftSpec(), null, 2);
      body.append(fileText);
      return;
    }
    body.append(textField('Title', draft.raceTitle, (value) => { draft.raceTitle = value; }));
    const repoField = textField('Repository folder', draft.repoPath, (value) => { draft.repoPath = value; });
    const repoInput = repoField.querySelector('input');
    const knownPaths = el('datalist');
    knownPaths.id = 'arena-repo-paths';
    for (const repoPath of new Set([...sessionUIs.values()].map((ui) => ui.path))) {
      const option = el('option');
      option.value = repoPath;
      knownPaths.append(option);
    }
    repoInput?.setAttribute('list', knownPaths.id);
    body.append(repoField, knownPaths);
    body.append(textField('Prompt', draft.prompt, (value) => { draft.prompt = value; }, true));
    body.append(buildCheckField());
    body.append(buildTimeLimitField());
    body.append(buildRoundsField());
    body.append(buildVaryBuilder(paint));
    body.append(buildLineupEditor(paint));
    const addButton = button({ variant: 'quiet', size: 'small', label: 'Add contestant', disabled: draft.contestants.length >= RACE_MAX_CONTESTANTS, onClick: () => {
      const firstAgent = agentsWithModels(catalog)[0] ?? 'claude-code';
      draft.contestants = relabel([...draft.contestants, { id: 'new', label: 'new', setup: draft.contestants.at(-1)?.setup ?? defaultSetup(catalog, firstAgent) }]);
      paint();
    } });
    body.append(addButton, buildJudgesEditor(paint));
  };
  const editAsFile = button({ variant: 'quiet', size: 'small', label: 'Edit as file', onClick: () => {
    if (isEditingAsFile) {
      const problem = readDraftFromFile(fileText.value);
      statusEl.textContent = problem ?? '';
      if (problem) return;
    }
    isEditingAsFile = !isEditingAsFile;
    editAsFile.setAttribute('aria-pressed', String(isEditingAsFile));
    paint();
  } });
  editAsFile.setAttribute('aria-pressed', 'false');
  const startButton = button({ variant: 'primary', label: 'Start race', onClick: () => {
    const spec: unknown = isEditingAsFile ? parseJsonText(fileText.value) : draftSpec();
    startButton.disabled = true;
    statusEl.textContent = 'Starting the contestants.';
    sendControlRequest('race-start', { spec }, { timeoutMs: START_TIMEOUT_MS })
      .then((reply) => {
        if (reply.type !== 'race-start-result') return;
        statusEl.textContent = reply.ok ? (reply.error ?? 'Race started.') : `Could not start the race: ${reply.error ?? 'unknown error'}`;
      })
      .catch((reason: unknown) => { statusEl.textContent = `Could not start the race: ${reason instanceof Error ? reason.message : String(reason)}`; })
      .finally(() => { startButton.disabled = false; });
  } });
  const head = el('div', 'arena-new-head');
  head.append(el('h2', 'arena-section-title', 'New race'), editAsFile);
  const actions = el('div', 'arena-actions');
  actions.append(startButton, statusEl);
  section.append(head, body, actions);
  paint();
  sendControlRequest('get-settings', {})
    .then((reply) => {
      if (reply.type !== 'settings') return;
      const parsed = AgentModelCatalog.safeParse(reply.settings.agentModels);
      if (!parsed.success) return;
      catalog = parsed.data;
      if (!hasDefaultJudge) draft.judges = [defaultSetup(catalog, RACE_JUDGE_AGENT)];
      hasDefaultJudge = true;
      if (draft.contestants.length === 0) draft.contestants = varyLineup(catalog, defaultSetup(catalog, agentsWithModels(catalog)[0] ?? 'claude-code'), 'agent', agentsWithModels(catalog).slice(0, 2));
      paint();
    })
    .catch((reason: unknown) => { statusEl.textContent = `Could not load the model list: ${reason instanceof Error ? reason.message : String(reason)}`; });
  return section;
}

function mountArenaView(parent: HTMLElement): void {
  if (root) return;
  root = el('div', 'arena-content');
  racesEl = el('section', 'arena-races');
  root.append(racesEl);
  if (!isPhoneLayout()) root.append(buildNewRace());
  const benchEl = el('section', 'arena-bench');
  root.append(benchEl);
  const paintBenchVisibility = () => { benchEl.hidden = benchmarkSnapshot().status?.configured !== true; };
  subscribeBenchmarks(paintBenchVisibility);
  paintBenchVisibility();
  parent.append(root);
  subscribeRaces(renderRaces);
  onSessionTick(renderRaces);
  renderRaces();
  void import('../benchmark-panel.ts').then((panel) => panel.view.mount(benchEl));
}

export const view: ViewModule<HTMLElement> = { mount: mountArenaView };
