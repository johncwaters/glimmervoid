import { createActionStatus, requestFailureText, DEFAULT_REPLY_TIMEOUT_MS } from '../action-status.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { isPhoneLayout } from '../form-factor.ts';
import { currentNotificationChoice, ensureNotificationPermission } from '../notifications.ts';
import { setNotificationsEnabled } from '../ui-prefs.ts';
import type { OperatorActionOf } from '#shared/contracts/control-messages.ts';
import { agentSummaryText, installableAgentsText, decideFirstRunSteps, decideOnboardingStepReports, firstRunAgentChoices, foundReposText, gitRepoChoicesIn, lastActivityText, notificationChoiceSummary, onboardingStepReportKey, rootsToAutoSave, hasGitCheckoutIn, shownRepoChoices, UPCOMING_STEPS } from './first-run-checklist-core.ts';
import type { FirstRunSteps, NotificationChoice, RepoChoice } from './first-run-checklist-core.ts';
import { buildLockMark } from '../loading-unlock.ts';
import { addSessionRefusalText, revealAddedSession } from '../session-actions.ts';
import { suggestSessionName } from '../session-card/naming.ts';
import { lastPathSegment, sessionNameBase } from '../add-session-core.ts';
import { clock } from '#shared/clock.ts';
import { createPressable } from '../ui/pressable.ts';
import { textArea, textInput } from '../ui/text-input.ts';
import { radio } from '../ui/checkbox.ts';
import { disclosure } from '../ui/disclosure.ts';
import { hasUnsettledCloneJobs, onCloneJobsSettled } from './clone-jobs.ts';
import { buildHostReadyRows } from '../host-ready/host-ready-rows.ts';
import { createRepoRootsAdder, saveRepoRoots } from './repo-roots-adder.ts';
import { buildCommandRow, buildSetupStep } from './setup-step.ts';
import { button } from '../ui/button.ts';

const AGENT_INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code';

type FirstRunState = { steps: FirstRunSteps; agentSummary: string; installableAgents: string; repoRoots: string[]; notificationChoice: NotificationChoice };
type FirstRunInputs = { agentListing: unknown; hasGitCheckout: boolean; notificationChoice: NotificationChoice };

const FIRST_TASKS = [
  { label: 'Map this repo on a board', scope: 'Reads only. Draws the map on a board here.', prompt: 'Map this repository on a new Glimmervoid whiteboard: one box per top-level module with its role in one line, wired by the imports between them. Read only; change no files. When the map is done, tell me in two lines where a newcomer should start reading.' },
  { label: 'Find and fix one small bug', scope: 'Edits a copy of the repo on a new branch. Nothing is pushed.', prompt: 'Find one small, real bug in this repository and fix it with the smallest change, on this session\'s branch. Run the tests that cover it. Push nothing; show me the diff and the test output when done.' },
  { label: 'Explain one module to me', scope: 'Reads only. Asks you one question at the end.', prompt: 'Pick the module of this repository a newcomer most needs to understand and explain it to me: what it does, what calls it, and the one thing most likely to surprise me. Read only; change no files. End by asking me one question about what I want to do next.' },
] as const;

let checklistEl: HTMLElement | null = null;
let stepsEl: HTMLOListElement | null = null;
let foundEl: HTMLElement | null = null;
let rescanButton: HTMLButtonElement | null = null;
let repoRootsAdder: ReturnType<typeof createRepoRootsAdder> | null = null;
let hostReadyRowsElement: HTMLElement | null = null;
let currentState: FirstRunState = { steps: UPCOMING_STEPS, agentSummary: '', installableAgents: installableAgentsText(null), repoRoots: [], notificationChoice: 'ask' };
let loadSequence = 0;
let hasRescanFoundNoAgent = false;
let hasTriedSavingFoundRoots = false;
const reportedStepKeys = new Set<string>();
const loadStatus = createActionStatus('first-run-load-status');
const startStatus = createActionStatus('first-run-start-status');
let latestInputs: FirstRunInputs | null = null;
let repoChoices: RepoChoice[] = [];
let chosenRepoPath: string | null = null;
let repoQuery = '';
let repoAddedThrough: keyof typeof ONBOARDING_ACTION_BY_SOURCE | null = null;
let chosenAgentId: string | null = null;
let pendingStart: Promise<void> | null = null;

function reportOnboardingAction(action: OperatorActionOf<'onboarding'>) {
  sendControlMsg({ type: 'dashboard-telemetry', event: 'operator_action', properties: { surface: 'onboarding', action } });
}

function reportOnboardingStepChanges(steps: FirstRunSteps) {
  for (const report of decideOnboardingStepReports(reportedStepKeys, steps)) {
    const isSent = sendControlMsg({ type: 'dashboard-telemetry', event: 'onboarding_step', properties: report });
    if (isSent) reportedStepKeys.add(onboardingStepReportKey(report));
  }
}

function agentStepLeadText(): string {
  if (isPhoneLayout()) return 'No agent found on PATH of the machine running Glimmervoid.';
  return 'No agent found on PATH.';
}

function agentStepBody(): HTMLElement[] {
  const actions = el('div', 'first-run-step-actions');
  rescanButton = button({ variant: 'primary', label: 'Rescan' });
  rescanButton.addEventListener('click', () => {
    reportOnboardingAction('rescan');
    void loadFirstRunState({ rescanAgents: true });
  });
  actions.append(rescanButton);
  const body = [el('p', 'first-run-step-text', agentStepLeadText()), buildCommandRow(AGENT_INSTALL_COMMAND), actions];
  if (!hasRescanFoundNoAgent) return body;
  return [...body, el('p', 'first-run-step-hint', 'Still missing after a rescan? Restart Glimmervoid from a terminal where the command runs. Other terminal agents go under customAgents.')];
}

const ONBOARDING_ACTION_BY_SOURCE = { typed: 'add-root-typed', suggested: 'add-root-suggested', 'cloned-url': 'clone-url', 'cloned-github': 'clone-github' } as const satisfies Record<string, OperatorActionOf<'onboarding'>>;

function repoRootsStepBody(): HTMLElement[] {
  const adder = repoRootsAdder ?? createRepoRootsAdder({ onAdded: (source) => {
    reportOnboardingAction(ONBOARDING_ACTION_BY_SOURCE[source]);
    repoAddedThrough = source;
    void loadFirstRunState({ rescanAgents: false });
  } });
  repoRootsAdder = adder;
  return [adder.element, hostReadyRowsFor(adder.element)];
}

function hostReadyRowsFor(adderElement: HTMLElement): HTMLElement {
  if (hostReadyRowsElement?.isConnected) return hostReadyRowsElement;
  hostReadyRowsElement = buildHostReadyRows({ openGithubConnection: () => focusGithubConnect(adderElement) }).element;
  return hostReadyRowsElement;
}

function focusGithubConnect(adderElement: HTMLElement) {
  const connectTarget = adderElement.querySelector<HTMLElement>('[data-action="github-connect"]:not([hidden])') ?? adderElement.querySelector<HTMLElement>('.repo-roots-adder-github');
  if (!connectTarget) return;
  if (!(connectTarget instanceof HTMLButtonElement)) connectTarget.tabIndex = -1;
  connectTarget.scrollIntoView({ block: 'center' });
  connectTarget.focus();
}

const SAMPLE_NOTIFICATION_TEXT = 'auth-refactor needs attention';

function answerNotifications(choice: 'allow' | 'skip') {
  reportOnboardingAction(choice === 'allow' ? 'allow-notifications' : 'skip-notifications');
  if (choice === 'skip') {
    setNotificationsEnabled(false);
    void loadFirstRunState({ rescanAgents: false });
    return;
  }
  void ensureNotificationPermission().then(() => loadFirstRunState({ rescanAgents: false }));
}

function notificationsStepBody(): HTMLElement[] {
  const sample = el('div', 'first-run-sample-notification');
  sample.setAttribute('aria-hidden', 'true');
  sample.append(buildLockMark('first-run-sample-mark'), el('span', null, SAMPLE_NOTIFICATION_TEXT));
  const allowButton = button({ variant: 'primary', label: 'Allow notifications' });
  const skipButton = button({ variant: 'quiet', label: 'Skip' });
  allowButton.addEventListener('click', () => {
    allowButton.disabled = true;
    answerNotifications('allow');
  });
  skipButton.addEventListener('click', () => answerNotifications('skip'));
  const actions = el('div', 'first-run-step-actions');
  actions.append(allowButton, skipButton);
  return [el('p', 'first-run-step-text', 'Know when a session needs you.'), sample, actions];
}

function chosenRepo(): RepoChoice | null {
  const picked = repoChoices.find((choice) => choice.path === chosenRepoPath);
  if (picked) return picked;
  return repoChoices.length === 1 ? repoChoices[0] : null;
}

function chooseRepo(path: string | null) {
  chosenRepoPath = path;
  repoQuery = '';
  startStatus.clear();
  applyLatestInputs();
}

function repoChoiceRow(choice: RepoChoice): HTMLButtonElement {
  const row = createPressable('first-run-repo-row');
  row.append(el('span', 'first-run-repo-name', choice.name), el('span', 'first-run-repo-root', lastPathSegment(choice.root)), el('span', 'first-run-repo-age', lastActivityText(choice.lastActivityMs, clock.nowMs())));
  row.addEventListener('click', () => chooseRepo(choice.path));
  return row;
}

function chooseRepoStepBody(): HTMLElement[] {
  const listEl = el('div', 'first-run-repo-list');
  const moreEl = el('p', 'first-run-step-hint');
  const renderList = () => {
    const { shown, moreCount } = shownRepoChoices(repoChoices, repoQuery);
    listEl.replaceChildren(...shown.map(repoChoiceRow));
    moreEl.textContent = shown.length === 0 ? 'No repo matches.' : moreCount > 0 ? `${moreCount} more, type to filter` : '';
    moreEl.hidden = moreEl.textContent === '';
  };
  renderList();
  const body: HTMLElement[] = [el('p', 'first-run-step-text', 'Pick the repo your first session works in. Latest activity first.')];
  if (repoChoices.length > shownRepoChoices(repoChoices, '').shown.length) {
    const filter = textInput({ type: 'search', placeholder: 'Filter repos', label: 'Filter repos', value: repoQuery, onInput: (query) => { repoQuery = query; renderList(); } });
    filter.addEventListener('keydown', (event) => {
      const [firstShown] = shownRepoChoices(repoChoices, repoQuery).shown;
      if (event.key === 'Enter' && firstShown) chooseRepo(firstShown.path);
    });
    body.push(filter);
  }
  return [...body, listEl, moreEl];
}

function agentChoiceRow(): HTMLElement {
  const { options, selectedId } = firstRunAgentChoices(latestInputs?.agentListing ?? null);
  const pickedId = options.some((option) => option.id === chosenAgentId) ? chosenAgentId : selectedId;
  chosenAgentId = pickedId;
  if (options.length < 2) return el('p', 'first-run-step-hint', `With ${options[0]?.label ?? 'your agent'}.`);
  const group = el('div', 'first-run-agent-choices');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Agent');
  group.append(...options.map((option) => radio({ name: 'first-run-agent', value: option.id, label: option.label, checked: option.id === pickedId, onSelect: () => { chosenAgentId = option.id; } }).element));
  return group;
}

function taskRow(task: (typeof FIRST_TASKS)[number]): HTMLElement {
  const row = el('div', 'first-run-task');
  const startButton = button({ variant: 'secondary', label: task.label, textCase: 'sentence' });
  startButton.addEventListener('click', () => startFirstSession(task.prompt));
  const promptView = disclosure({ summary: 'Show prompt', marker: 'chevron', body: () => el('p', 'first-run-task-prompt', task.prompt) });
  row.append(startButton, el('p', 'first-run-step-hint', task.scope), promptView.element);
  return row;
}

function ownPromptRow(): HTMLElement {
  const promptInput = textArea({ rows: 3, label: 'Your prompt', placeholder: 'What should the agent do in this repo?' });
  const startButton = button({ variant: 'primary', label: 'Start session' });
  startButton.addEventListener('click', () => {
    const prompt = promptInput.value.trim();
    if (!prompt) {
      startStatus.show('error', 'Write a prompt first.');
      promptInput.focus();
      return;
    }
    startFirstSession(prompt);
  });
  const actions = el('div', 'first-run-step-actions');
  actions.append(startButton);
  return disclosure({ summary: 'Write my own prompt', marker: 'chevron', body: [promptInput, actions] }).element;
}

function startStepBody(): HTMLElement[] {
  const repo = chosenRepo();
  if (!repo) return [];
  const repoLine = el('div', 'first-run-step-actions');
  repoLine.append(el('span', 'first-run-step-text', `In ${repo.name}`));
  if (repoChoices.length > 1) {
    const changeButton = button({ variant: 'quiet', label: 'Change', size: 'small', textCase: 'sentence' });
    changeButton.addEventListener('click', () => chooseRepo(null));
    repoLine.append(changeButton);
  }
  const tasks = el('div', 'first-run-tasks');
  tasks.append(...FIRST_TASKS.map(taskRow), ownPromptRow());
  return [repoLine, el('p', 'first-run-step-hint', 'It works on a new branch in its own worktree. Your checkout is untouched.'), agentChoiceRow(), tasks, startStatus.element];
}

function setStartControlsDisabled(isDisabled: boolean) {
  for (const control of stepsEl?.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('.first-run-tasks button, .first-run-tasks textarea') ?? []) control.disabled = isDisabled;
}

function reportFirstSessionStarted() {
  reportOnboardingAction('start-session');
  const report = { step: 'first_session', state: 'done' } as const;
  if (sendControlMsg({ type: 'dashboard-telemetry', event: 'onboarding_step', properties: report })) reportedStepKeys.add(onboardingStepReportKey(report));
}

function startFirstSession(prompt: string) {
  const repo = chosenRepo();
  if (!repo || pendingStart) return;
  setStartControlsDisabled(true);
  startStatus.show('busy', 'Starting the session');
  const request = { name: suggestSessionName(sessionNameBase(repo.name)), path: repo.path, prompt, ...(chosenAgentId ? { agent: chosenAgentId } : {}) };
  pendingStart = sendControlRequest('add-session', request, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS })
    .then((reply) => {
      if (reply.type === 'add-session-result' && reply.ok) {
        startStatus.clear();
        reportFirstSessionStarted();
        revealAddedSession(reply.sessionId);
        return;
      }
      startStatus.show('error', addSessionRefusalText(reply));
    })
    .catch((reason: unknown) => { startStatus.show('error', `The session was not added: ${requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS)}`); })
    .finally(() => {
      pendingStart = null;
      setStartControlsDisabled(false);
    });
}

type SetupStepRow = { title: string; state: FirstRunSteps[keyof FirstRunSteps]; summary: string; body: () => HTMLElement[] };

function setupStepRows(): HTMLLIElement[] {
  const { steps, agentSummary, repoRoots, notificationChoice } = currentState;
  const isRepoRootsShown = steps.repoRoots === 'current' || repoAddedThrough !== null;
  const rows: SetupStepRow[] = [
    { title: 'Agent CLI', state: steps.agent, summary: agentSummary, body: agentStepBody },
    ...(isRepoRootsShown ? [{ title: 'Add a repository', state: steps.repoRoots, summary: repoRoots.join(', '), body: repoRootsStepBody }] : []),
    { title: 'Notifications', state: steps.notifications, summary: notificationChoiceSummary(notificationChoice), body: notificationsStepBody },
    { title: 'Choose a repo', state: steps.chooseRepo, summary: chosenRepo()?.name ?? '', body: chooseRepoStepBody },
    { title: 'Start a session', state: steps.start, summary: '', body: startStepBody },
  ];
  return rows.map((row, index) => buildSetupStep({ ...row, title: `${index + 1}. ${row.title}`, badge: '' }));
}

function renderSteps() {
  if (!stepsEl) return;
  const focusedFilter = document.activeElement instanceof HTMLInputElement && stepsEl.contains(document.activeElement) && document.activeElement.type === 'search';
  stepsEl.replaceChildren(...setupStepRows());
  if (foundEl) {
    foundEl.textContent = foundReposText(repoChoices);
    foundEl.hidden = foundEl.textContent === '';
  }
  if (focusedFilter) stepsEl.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
}

function applyLatestInputs() {
  if (!latestInputs) return;
  const { agentListing, hasGitCheckout, notificationChoice } = latestInputs;
  const steps = decideFirstRunSteps({ agentListing, hasGitCheckout, notificationChoice, hasChosenRepo: chosenRepo() !== null, hasStarted: false });
  currentState = { ...currentState, steps };
  renderSteps();
  reportOnboardingStepChanges(steps);
}

async function loadFirstRunState({ rescanAgents }: { rescanAgents: boolean }) {
  loadSequence += 1;
  const sequenceAtStart = loadSequence;
  if (rescanButton) rescanButton.disabled = true;
  try {
    const [agentListing, rootsScan] = await Promise.all([
      sendControlRequest('list-agents', rescanAgents ? { rescan: true } : {}, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS }),
      sendControlRequest('scan-repo-roots', { includeSuggestions: true, includeActivity: true }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS }),
    ]);
    if (sequenceAtStart !== loadSequence) return;
    const isRootsScan = rootsScan.type === 'repo-roots-scanned';
    const repoRoots = isRootsScan ? rootsScan.directories.map((directory) => directory.root) : [];
    const suggestions = isRootsScan ? rootsScan.suggestions ?? [] : [];
    const hasGitCheckout = isRootsScan && hasGitCheckoutIn(rootsScan.directories);
    const foundRoots = rootsToAutoSave(hasGitCheckout, suggestions);
    if (foundRoots.length > 0 && !hasTriedSavingFoundRoots) {
      hasTriedSavingFoundRoots = true;
      const saveError = await saveRepoRoots(foundRoots).catch((reason: unknown) => String(reason));
      if (sequenceAtStart !== loadSequence) return;
      if (!saveError) {
        void loadFirstRunState({ rescanAgents: false });
        return;
      }
    }
    const notificationChoice = currentNotificationChoice();
    const isWaitingOnClones = hasUnsettledCloneJobs();
    repoChoices = isRootsScan ? gitRepoChoicesIn(rootsScan.directories) : [];
    latestInputs = { agentListing, hasGitCheckout: hasGitCheckout && !isWaitingOnClones, notificationChoice };
    const steps = decideFirstRunSteps({ ...latestInputs, hasChosenRepo: chosenRepo() !== null, hasStarted: false });
    if (rescanAgents) hasRescanFoundNoAgent = steps.agent === 'current';
    currentState = { steps, agentSummary: agentSummaryText(agentListing), installableAgents: installableAgentsText(agentListing), repoRoots, notificationChoice };
    loadStatus.clear();
    renderSteps();
    reportOnboardingStepChanges(currentState.steps);
    repoRootsAdder?.setSuggestions(suggestions);
  } catch (reason) {
    if (rescanButton) rescanButton.disabled = false;
    if (sequenceAtStart !== loadSequence) return;
    loadStatus.show('error', `The checklist could not load: ${requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS)} It loads again once the server answers. If it stays like this, check the terminal running Glimmervoid, or run glimmervoid doctor.`);
  }
}

const AUTO_RESCAN_GAP_MS = 5000;
let lastAutoRescanAtMs = Number.NEGATIVE_INFINITY;

function rescanWhenAgentMissing() {
  if (document.visibilityState !== 'visible' || currentState.steps.agent !== 'current') return;
  if (!checklistEl || checklistEl.hidden || !checklistEl.isConnected) return;
  if (performance.now() - lastAutoRescanAtMs < AUTO_RESCAN_GAP_MS) return;
  lastAutoRescanAtMs = performance.now();
  void loadFirstRunState({ rescanAgents: true });
}

function ensureChecklist(): HTMLElement {
  if (checklistEl) return checklistEl;
  const checklist = el('section', 'first-run-checklist');
  checklist.setAttribute('aria-label', 'Glimmervoid setup');
  const lockup = el('div', 'first-run-lockup');
  lockup.append(buildLockMark('first-run-mark'), el('span', 'first-run-wordmark', 'GLIMMERVOID'));
  foundEl = el('p', 'first-run-found');
  foundEl.hidden = true;
  stepsEl = el('ol', 'first-run-steps');
  checklist.append(lockup, foundEl, stepsEl, loadStatus.element);
  checklistEl = checklist;
  onCloneJobsSettled(refreshFirstRunChecklist);
  document.addEventListener('visibilitychange', rescanWhenAgentMissing);
  window.addEventListener('focus', rescanWhenAgentMissing);
  renderSteps();
  return checklist;
}

export function showFirstRunChecklist(host: HTMLElement, isShown: boolean) {
  if (!isShown) {
    if (checklistEl?.parentElement === host && !checklistEl.hidden) checklistEl.hidden = true;
    return;
  }
  const checklist = ensureChecklist();
  const wasShownHere = !checklist.hidden && checklist.parentElement === host;
  if (checklist.parentElement !== host) host.append(checklist);
  checklist.hidden = false;
  if (!wasShownHere) void loadFirstRunState({ rescanAgents: false });
}

export function refreshFirstRunChecklist() {
  if (!checklistEl || checklistEl.hidden || !checklistEl.isConnected) return;
  void loadFirstRunState({ rescanAgents: false });
}
