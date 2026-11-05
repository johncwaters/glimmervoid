import { AgentModelCatalog } from '#shared/contracts/agent-models.ts';
import type { AgentSetup } from '#shared/contracts/agent-models.ts';
import type { RaceContestant, RaceRecord } from '#shared/contracts/race.ts';
import { RACE_JUDGE_AGENT, RACE_MAX_CONTESTANTS, RaceSpec } from '#shared/contracts/race.ts';
import { REMOVED_CONTESTANT, raceProgress } from '#shared/race-core.ts';
import { BADGE_LABELS } from '#shared/states.ts';
import { benchmarkSnapshot, subscribeBenchmarks } from '../benchmark-store.ts';
import { sendControlRequest } from '../control-ws.ts';
import './arena-panel.css';
import { el } from '../dom-helpers.ts';
import { isPhoneLayout } from '../form-factor.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { onSessionTick } from '../session-card/session-tick.ts';
import { button } from '../ui/button.ts';
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
  judgeSetup: AgentSetup | null;
}

let root: HTMLElement | null = null;
let racesEl: HTMLElement | null = null;
let catalog: AgentModelCatalog = { agents: [] };
let draft: RaceDraft = { raceTitle: '', prompt: '', repoPath: '', contestants: [], judgeSetup: null };
let isEditingAsFile = false;
const shownDiffByKey = new Map<string, string>();
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

function buildContestantLine(race: RaceRecord, contestant: RaceContestant): HTMLElement {
  const line = el('li', 'arena-contestant');
  const sessionId = race.sessionIdByContestant[contestant.id];
  const state = contestantState(sessionId);
  const ranking = race.judge?.ranking.find((entry) => entry.contestantId === contestant.id) ?? null;
  const stats = race.diffStatsByContestant[contestant.id];
  const head = el('div', 'arena-contestant-head');
  head.append(el('span', 'arena-contestant-rank', ranking ? `#${ranking.rank}` : '-'));
  head.append(el('span', 'arena-contestant-label', contestant.label));
  head.append(el('span', 'arena-contestant-state', state === REMOVED_CONTESTANT ? 'Removed' : stateLabel(state)));
  if (stats) head.append(el('span', 'arena-contestant-stats', `+${stats.linesAdded} -${stats.linesRemoved}, ${stats.filesChanged} files`));
  if (sessionId && state !== REMOVED_CONTESTANT) {
    head.append(button({ variant: 'quiet', size: 'small', label: 'Open', onClick: () => openRaceSession(sessionId) }));
    const diffButton = button({ variant: 'quiet', size: 'small', label: 'Show diff', onClick: () => requestDiff(race, contestant) });
    diffButton.setAttribute('aria-expanded', String(shownDiffByKey.has(diffKey(race.id, contestant.id))));
    head.append(diffButton);
  }
  line.append(head);
  if (ranking) line.append(el('p', 'arena-contestant-reason', ranking.reason));
  const shownDiff = shownDiffByKey.get(diffKey(race.id, contestant.id));
  if (shownDiff !== undefined) line.append(el('pre', 'arena-diff', shownDiff));
  return line;
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
  if (race.phase === 'judging') return 'Judging.';
  if (race.phase === 'judged') return [race.judge ? 'Judged.' : 'Finished.', race.judgeError].filter(Boolean).join(' ');
  return `${progress.settled} of ${progress.total} settled.`;
}

function rankedContestants(race: RaceRecord): RaceContestant[] {
  const rankOf = (contestant: RaceContestant) => race.judge?.ranking.find((entry) => entry.contestantId === contestant.id)?.rank ?? Number.MAX_SAFE_INTEGER;
  return [...race.spec.contestants].sort((left, right) => rankOf(left) - rankOf(right));
}

function buildRace(race: RaceRecord): HTMLElement {
  const item = el('article', 'arena-race');
  item.append(el('h3', 'arena-race-title', race.spec.title));
  item.append(el('p', 'arena-race-meta', `${race.baseBranch} at ${race.startSha.slice(0, SHORT_SHA_LENGTH)}, ${new Date(race.createdAt).toLocaleString()}`));
  const actions = el('div', 'arena-race-actions');
  const judgeButton = button({ variant: 'secondary', size: 'small', label: 'Judge now', disabled: race.phase === 'judging', onClick: () => judgeRace(race) });
  const statusEl = el('span', 'arena-status', judgeStatusByRace.get(race.id) || phaseText(race));
  statusEl.setAttribute('role', 'status');
  actions.append(judgeButton, statusEl);
  item.append(actions);
  const lineup = el('ul', 'arena-contestants');
  for (const contestant of rankedContestants(race)) lineup.append(buildContestantLine(race, contestant));
  item.append(lineup);
  return item;
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
  const select = el('select', 'arena-select');
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
    judge: draft.judgeSetup ? { setup: draft.judgeSetup } : null,
  };
}

function textField(label: string, value: string, onInput: (value: string) => void, isMultiline = false): HTMLElement {
  const field = el('label', 'arena-field');
  field.append(el('span', 'arena-field-label', label));
  const input = isMultiline ? el('textarea', 'arena-input arena-prompt') : el('input', 'arena-input');
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
    const instructions = el('textarea', 'arena-input arena-instructions');
    instructions.placeholder = 'Extra instructions for this contestant';
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

function buildVaryBuilder(onChanged: () => void): HTMLElement {
  const builder = el('div', 'arena-vary');
  let base = draft.contestants[0]?.setup ?? defaultSetup(catalog, agentsWithModels(catalog)[0] ?? 'claude-code');
  let setting: VarySetting = 'model';
  const choicesEl = el('div', 'arena-vary-choices');
  const paintChoices = () => {
    choicesEl.replaceChildren();
    for (const choice of varyChoices(catalog, base, setting)) {
      const option = el('label', 'arena-vary-choice');
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
  draft = { raceTitle: spec.title, prompt: spec.prompt, repoPath: spec.repoPath, contestants: spec.contestants, judgeSetup: spec.judge?.setup ?? null };
  return null;
}

function buildNewRace(): HTMLElement {
  const section = el('section', 'arena-new');
  const body = el('div', 'arena-new-body');
  const statusEl = el('span', 'arena-status');
  statusEl.setAttribute('role', 'status');
  const fileText = el('textarea', 'arena-input arena-file');
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
    body.append(buildVaryBuilder(paint));
    body.append(buildLineupEditor(paint));
    const addButton = button({ variant: 'quiet', size: 'small', label: 'Add contestant', disabled: draft.contestants.length >= RACE_MAX_CONTESTANTS, onClick: () => {
      const firstAgent = agentsWithModels(catalog)[0] ?? 'claude-code';
      draft.contestants = relabel([...draft.contestants, { id: 'new', label: 'new', setup: draft.contestants.at(-1)?.setup ?? defaultSetup(catalog, firstAgent) }]);
      paint();
    } });
    const judge = el('label', 'arena-judge');
    const judgeBox = el('input');
    judgeBox.type = 'checkbox';
    judgeBox.checked = draft.judgeSetup !== null;
    judgeBox.addEventListener('change', () => {
      draft.judgeSetup = judgeBox.checked ? defaultSetup(catalog, RACE_JUDGE_AGENT) : null;
      paint();
    });
    judge.append(judgeBox, el('span', null, 'Judge the results'));
    if (draft.judgeSetup) judge.append(setupControls(draft.judgeSetup, (next) => { draft.judgeSetup = next; paint(); }, [RACE_JUDGE_AGENT]));
    body.append(addButton, judge);
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
      draft.judgeSetup ??= defaultSetup(catalog, RACE_JUDGE_AGENT);
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
