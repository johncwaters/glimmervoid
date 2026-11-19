import { AgentHomeKind, AgentModelCatalog, CLEAN_HOME_AGENT_IDS } from '#shared/contracts/agent-models.ts';
import type { AgentSetup } from '#shared/contracts/agent-models.ts';
import type { RaceCheck, RaceContestant, RaceReviewCase, ReviewCaseEntry } from '#shared/contracts/race.ts';
import { RACE_JUDGE_AGENTS, RACE_MAX_CONTESTANTS, RACE_MAX_JUDGES, RACE_MAX_ROUNDS, RaceSpec } from '#shared/contracts/race.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { textArea, textInput } from '../ui/text-input.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { button } from '../ui/button.ts';
import { checkbox } from '../ui/checkbox.ts';
import { field as uiField } from '../ui/field.ts';
import { buildDialogShell } from '../session-card/modal.ts';
import { agentsWithModels, contestantsFor, defaultSetup, VARY_SETTINGS, varyChoices, varyLineup } from './lineup-core.ts';
import { buildSelect, setupControls } from './setup-controls.ts';
import type { VarySetting } from './lineup-core.ts';

const START_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 60_000;
const SHORT_SHA_LENGTH = 8;
const MINE_TIMEOUT_MS = 300_000;
const DEFAULT_REVIEW_PROMPT = 'Review this pull request for defects.';
const DEFAULT_CHECK_TIMEOUT_SECONDS = 600;

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
  reviewCase: RaceReviewCase | null;
}

let catalog: AgentModelCatalog = AgentModelCatalog.parse({ agents: [] });
let draft: RaceDraft = { raceTitle: '', prompt: '', repoPath: '', contestants: [], judges: [], check: null, checkTimeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS, timeLimitMinutes: null, rounds: 1, reviewCase: null };
let judgeSeed: 'pending' | 'settled' = 'pending';
let isEditingAsFile = false;

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
    reviewCase: draft.reviewCase,
  };
}

function parseCheckCommand(text: string): RaceCheck | null {
  const [program, ...args] = text.trim().split(/\s+/).filter(Boolean);
  if (!program) return null;
  return { program, args, timeoutSeconds: draft.checkTimeoutSeconds };
}

function buildCheckField(): HTMLElement {
  const field = el('div', 'arena-check');
  const command = textField('Check command', draft.check ? [draft.check.program, ...draft.check.args].join(' ') : '', (value) => { draft.check = parseCheckCommand(value); }, { hint: 'Runs in each checkout once it finishes.' });
  command.querySelector('input')?.setAttribute('placeholder', 'npm test');
  const timeoutInput = textInput({ type: 'number', value: String(draft.checkTimeoutSeconds), onInput: (value) => {
    draft.checkTimeoutSeconds = Number(value) || DEFAULT_CHECK_TIMEOUT_SECONDS;
    if (draft.check) draft.check = { ...draft.check, timeoutSeconds: draft.checkTimeoutSeconds };
  } });
  timeoutInput.min = '5';
  timeoutInput.max = '3600';
  field.append(command, uiField({ label: 'Check time limit (seconds)', control: timeoutInput }).element);
  return field;
}

function buildTimeLimitField(): HTMLElement {
  const input = textInput({ type: 'number', value: draft.timeLimitMinutes === null ? '' : String(draft.timeLimitMinutes), onInput: (value) => {
    const minutes = Number(value);
    draft.timeLimitMinutes = value.trim() === '' || !Number.isInteger(minutes) || minutes < 1 ? null : Math.min(minutes, 720);
  } });
  input.min = '1';
  input.max = '720';
  return uiField({ label: 'Time limit (minutes)', control: input, hint: 'Empty for none.' }).element;
}

function buildRoundsField(): HTMLElement {
  const input = textInput({ type: 'number', value: String(draft.rounds), onInput: (value) => {
    const rounds = Number(value);
    draft.rounds = Number.isInteger(rounds) ? Math.min(Math.max(rounds, 1), RACE_MAX_ROUNDS) : 1;
  } });
  input.min = '1';
  input.max = String(RACE_MAX_ROUNDS);
  return uiField({ label: 'Rounds', control: input, hint: `1 to ${RACE_MAX_ROUNDS}, run one after another.` }).element;
}

function textField(label: string, value: string, onInput: (value: string) => void, { isMultiline = false, hint = '' }: { isMultiline?: boolean; hint?: string } = {}): HTMLElement {
  const control = isMultiline ? textArea({ value, onInput }) : textInput({ value, onInput });
  if (isMultiline) control.classList.add('arena-prompt');
  return uiField({ label, control, hint }).element;
}

const OPERATOR_HOME_CHOICE = { value: 'operator', label: 'Your setup' };
const CLEAN_HOME_CHOICE = { value: 'clean', label: 'Clean home' };

function homeChoicesFor(agent: string): { value: string; label: string }[] {
  return CLEAN_HOME_AGENT_IDS.includes(agent) ? [OPERATOR_HOME_CHOICE, CLEAN_HOME_CHOICE] : [OPERATOR_HOME_CHOICE];
}

function relabel(contestants: RaceContestant[]): RaceContestant[] {
  return contestantsFor(catalog, contestants);
}

function buildLineupEditor(onChanged: () => void): HTMLElement {
  const lineup = el('div', 'arena-lineup');
  draft.contestants.forEach((contestant, index) => {
    const column = el('div', 'arena-column');
    column.append(el('span', 'arena-column-label', contestant.label));
    column.append(setupControls(catalog, contestant.setup, (next) => {
      draft.contestants = relabel(draft.contestants.map((existing, position) => (position === index ? { ...existing, setup: next, home: CLEAN_HOME_AGENT_IDS.includes(next.agent) ? existing.home : 'operator' } : existing)));
      onChanged();
    }));
    column.append(buildSelect(homeChoicesFor(contestant.setup.agent), contestant.home, (home) => {
      draft.contestants = relabel(draft.contestants.map((existing, position) => (position === index ? { ...existing, home: AgentHomeKind.parse(home) } : existing)));
      onChanged();
    }, 'Home'));
    const instructions = textArea({ value: contestant.setup.instructions, placeholder: 'Extra instructions for this contestant', label: 'Extra instructions for this contestant', onInput: (value) => {
      draft.contestants = draft.contestants.map((existing, position) => (position === index ? { ...existing, setup: { ...existing.setup, instructions: value } } : existing));
    } });
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
  draft.judges.forEach((judge, index) => {
    const row = el('div', 'arena-judge');
    row.append(setupControls(catalog, judge, (next) => {
      draft.judges = draft.judges.map((existing, position) => (position === index ? next : existing));
      onChanged();
    }, { allowedAgents: RACE_JUDGE_AGENTS, allowsOpenRouter: false }));
    row.append(button({ variant: 'quiet', size: 'small', label: 'Remove', onClick: () => {
      draft.judges = draft.judges.filter((_existing, position) => position !== index);
      onChanged();
    } }));
    judges.append(row);
  });
  judges.append(button({ variant: 'quiet', size: 'small', label: 'Add judge', disabled: draft.judges.length >= RACE_MAX_JUDGES, onClick: () => {
    draft.judges = [...draft.judges, draft.judges.at(-1) ?? defaultSetup(catalog, RACE_JUDGE_AGENTS[0])];
    onChanged();
  } }));
  return uiField({ label: 'Judges', control: judges, hint: draft.judges.length === 0 ? 'None, the race is not judged.' : `${draft.judges.length} of ${RACE_MAX_JUDGES}.` }).element;
}

function buildVaryBuilder(onChanged: () => void): HTMLElement {
  const builder = el('div', 'arena-vary');
  let base = draft.contestants[0]?.setup ?? defaultSetup(catalog, agentsWithModels(catalog)[0] ?? 'claude-code');
  let setting: VarySetting = 'model';
  const choicesEl = el('div', 'arena-vary-choices');
  const paintChoices = () => {
    choicesEl.replaceChildren();
    for (const choice of varyChoices(catalog, base, setting)) {
      choicesEl.append(checkbox({ label: choice.label, value: choice.value }).element);
    }
  };
  const baseEl = el('div', 'arena-vary-base');
  const paintBase = () => {
    baseEl.replaceChildren(setupControls(catalog, base, (next) => { base = next; paintBase(); paintChoices(); }));
  };
  const settingSelect = buildSelect(VARY_SETTINGS.map((value) => ({ value, label: value })), setting, (value) => {
    setting = VARY_SETTINGS.find((candidate) => candidate === value) ?? 'model';
    paintChoices();
  }, 'Setting to vary');
  builder.append(uiField({ label: 'Start from', control: baseEl }).element, uiField({ label: 'Vary', control: settingSelect }).element);
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
  draft = { raceTitle: spec.title, prompt: spec.prompt, repoPath: spec.repoPath, contestants: spec.contestants, judges: spec.judges.map((judge) => judge.setup), check: spec.check, checkTimeoutSeconds: spec.check?.timeoutSeconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS, timeLimitMinutes: spec.timeLimitMinutes, rounds: spec.rounds, reviewCase: spec.reviewCase };
  judgeSeed = 'settled';
  return null;
}

function useReviewCase(entry: ReviewCaseEntry): void {
  draft.reviewCase = entry.reviewCase;
  if (draft.raceTitle.trim() === '') draft.raceTitle = `Review ${entry.title}`.slice(0, 120);
  if (draft.prompt.trim() === '') draft.prompt = DEFAULT_REVIEW_PROMPT;
}

function buildCaseRow(entry: ReviewCaseEntry, onPicked: () => void): HTMLElement {
  const row = el('li', 'arena-case');
  const text = el('div', 'arena-case-text');
  text.append(el('span', 'arena-case-title', entry.title));
  text.append(el('span', 'arena-status', `${entry.reviewCase.repo}, ${entry.reviewCase.references.length} review comments, ${entry.reviewCase.changedFiles.length} files`));
  row.append(text, button({ variant: 'secondary', size: 'small', label: 'Use this case', onClick: () => {
    useReviewCase(entry);
    onPicked();
  } }));
  return row;
}

function openCasePicker(onPicked: () => void): void {
  const { dialog, close, actions, btnCancel } = buildDialogShell({ title: 'Start from a review case' });
  const statusEl = el('p', 'arena-status');
  statusEl.setAttribute('role', 'status');
  const list = el('ul', 'arena-cases');
  const loadCases = () => {
    statusEl.textContent = 'Loading the review cases.';
    sendControlRequest('race-cases', {}, { timeoutMs: REQUEST_TIMEOUT_MS })
      .then((reply) => {
        if (reply.type !== 'race-cases-result') return;
        const cases = reply.cases ?? [];
        list.replaceChildren(...cases.map((entry) => buildCaseRow(entry, () => { close(); onPicked(); })));
        statusEl.textContent = reply.ok ? (cases.length === 0 ? 'No review cases yet. Mine some from a repository below.' : '') : `Could not list the review cases: ${reply.error ?? 'unknown error'}`;
      })
      .catch((reason: unknown) => { statusEl.textContent = `Could not list the review cases: ${reason instanceof Error ? reason.message : String(reason)}`; });
  };
  const repoInput = textInput({ value: draft.reviewCase?.repo ?? '', placeholder: 'owner/repo', label: 'Repository to mine merged pull requests from' });
  const mineButton = button({ variant: 'secondary', size: 'small', label: 'Mine cases', onClick: () => {
    mineButton.disabled = true;
    statusEl.textContent = `Mining merged pull requests of ${repoInput.value.trim()}.`;
    sendControlRequest('race-mine-cases', { repo: repoInput.value.trim() }, { timeoutMs: MINE_TIMEOUT_MS })
      .then((reply) => {
        if (reply.type !== 'race-mine-cases-result') return;
        if (!reply.ok) {
          statusEl.textContent = `Could not mine cases: ${reply.error ?? 'unknown error'}`;
          return;
        }
        loadCases();
      })
      .catch((reason: unknown) => { statusEl.textContent = `Could not mine cases: ${reason instanceof Error ? reason.message : String(reason)}`; })
      .finally(() => { mineButton.disabled = false; });
  } });
  const mineRow = el('div', 'arena-case-mine');
  mineRow.append(repoInput, mineButton);
  dialog.append(list, mineRow, statusEl, actions);
  btnCancel.addEventListener('click', close);
  loadCases();
}

function buildReviewCaseField(onChanged: () => void): HTMLElement {
  const reviewCase = draft.reviewCase;
  const hint = reviewCase
    ? `${reviewCase.repo} ${reviewCase.caseId} at ${reviewCase.headSha.slice(0, SHORT_SHA_LENGTH)}, ${reviewCase.references.length} review comments. Contestants review it and are ranked by recall.`
    : 'None, contestants work on the prompt.';
  const controls = el('div', 'arena-actions');
  controls.append(button({ variant: 'quiet', size: 'small', label: 'Start from case', onClick: () => openCasePicker(onChanged) }));
  if (reviewCase) controls.append(button({ variant: 'quiet', size: 'small', label: 'Clear case', onClick: () => {
    draft.reviewCase = null;
    onChanged();
  } }));
  return uiField({ label: 'Review case', control: controls, hint }).element;
}

function formGroup(title: string, hint: string, ...fields: HTMLElement[]): HTMLElement {
  const group = el('section', 'arena-form-group');
  const head = el('div', 'arena-form-group-head');
  head.append(el('h3', 'arena-label', title), el('p', 'arena-form-group-hint', hint));
  const body = el('div', 'arena-form-group-body');
  body.append(...fields);
  group.append(head, body);
  return group;
}

export function buildNewRace(onStarted: () => void): HTMLElement {
  const section = el('section', 'arena-new');
  const body = el('div', 'arena-new-body');
  const statusEl = el('span', 'arena-status');
  statusEl.setAttribute('role', 'status');
  const fileText = textArea({ label: 'Race spec JSON', spellcheck: false });
  fileText.classList.add('arena-file');
  const paint = () => {
    body.replaceChildren();
    fileText.hidden = !isEditingAsFile;
    if (isEditingAsFile) {
      fileText.value = JSON.stringify(draftSpec(), null, 2);
      body.append(fileText);
      return;
    }
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
    const addButton = button({ variant: 'secondary', size: 'small', label: 'Add contestant', disabled: draft.contestants.length >= RACE_MAX_CONTESTANTS, onClick: () => {
      const firstAgent = agentsWithModels(catalog)[0] ?? 'claude-code';
      draft.contestants = relabel([...draft.contestants, { id: 'new', label: 'new', setup: draft.contestants.at(-1)?.setup ?? defaultSetup(catalog, firstAgent), home: draft.contestants.at(-1)?.home ?? 'operator', doneMeans: draft.contestants.at(-1)?.doneMeans }]);
      paint();
    } });
    const lineupActions = el('div', 'arena-actions');
    lineupActions.append(addButton, el('span', 'arena-status', `${draft.contestants.length} of ${RACE_MAX_CONTESTANTS} contestants`));
    body.append(
      formGroup('Task', 'What every contestant works on, from the same commit of the integration branch.',
        textField('Title', draft.raceTitle, (value) => { draft.raceTitle = value; }), repoField, knownPaths, buildReviewCaseField(paint),
        textField('Prompt', draft.prompt, (value) => { draft.prompt = value; }, { isMultiline: true })),
      formGroup('Lineup', 'Each contestant runs in its own session and worktree. Fill the lineup by varying one setting, or set each column by hand.',
        buildVaryBuilder(paint), buildLineupEditor(paint), lineupActions),
      formGroup('Judging', 'Judges rank the contestants that changed something. A check command runs in each checkout before they read it.',
        buildJudgesEditor(paint), buildCheckField()),
      formGroup('Limits', 'A contestant still working at the time limit is recorded as did not finish.',
        buildTimeLimitField(), buildRoundsField()),
    );
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
        statusEl.textContent = reply.ok ? (reply.error ?? '') : `Could not start the race: ${reply.error ?? 'unknown error'}`;
        if (reply.ok) onStarted();
      })
      .catch((reason: unknown) => { statusEl.textContent = `Could not start the race: ${reason instanceof Error ? reason.message : String(reason)}`; })
      .finally(() => { startButton.disabled = false; });
  } });
  const head = el('div', 'arena-new-head');
  head.append(el('h2', 'arena-section-title', 'New race'), editAsFile);
  const actions = el('div', 'arena-actions arena-new-actions');
  actions.append(startButton, statusEl);
  section.append(head, body, actions);
  paint();
  sendControlRequest('get-settings', {})
    .then((reply) => {
      if (reply.type !== 'settings') return;
      const parsed = AgentModelCatalog.safeParse(reply.settings.agentModels);
      if (!parsed.success) return;
      catalog = parsed.data;
      if (judgeSeed === 'pending') draft.judges = [defaultSetup(catalog, RACE_JUDGE_AGENTS[0])];
      judgeSeed = 'settled';
      if (draft.contestants.length === 0) draft.contestants = varyLineup(catalog, defaultSetup(catalog, agentsWithModels(catalog)[0] ?? 'claude-code'), 'agent', agentsWithModels(catalog).slice(0, 2));
      paint();
    })
    .catch((reason: unknown) => { statusEl.textContent = `Could not load the model list: ${reason instanceof Error ? reason.message : String(reason)}`; });
  return section;
}
