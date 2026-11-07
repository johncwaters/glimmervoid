import { createActionStatus, requestFailureText, DEFAULT_REPLY_TIMEOUT_MS } from '../action-status.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { el, elWithMarkup } from '../dom-helpers.ts';
import { isPhoneLayout } from '../form-factor.ts';
import { currentNotificationChoice, ensureNotificationPermission } from '../notifications.ts';
import { setNotificationsEnabled } from '../ui-prefs.ts';
import type { OperatorActionOf } from '#shared/contracts/control-messages.ts';
import { BRAND_MARK_BRACKETS, BRAND_MARK_LIGHT, BRAND_MARK_VIEWBOX } from '#shared/brand-mark.ts';
import { agentSummaryText, startProjects, installableAgentsText, decideFirstRunSteps, decideOnboardingStepReports, isSetupDone, notificationChoiceSummary, onboardingStepReportKey, rootsToAutoSave, UPCOMING_STEPS } from './first-run-checklist-core.ts';
import type { FirstRunSteps, NotificationChoice, StartProject } from './first-run-checklist-core.ts';
import { createStartForm } from './start-form.ts';
import { createRepoRootsAdder, saveRepoRoots } from './repo-roots-adder.ts';
import { buildCommandRow, buildSetupStep } from './setup-step.ts';
import { button } from '../ui/button.ts';

const AGENT_INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code';

type FirstRunState = { steps: FirstRunSteps; agentSummary: string; installableAgents: string; repoRoots: string[]; notificationChoice: NotificationChoice; agentListing: unknown; startableProjects: StartProject[] };

let checklistEl: HTMLElement | null = null;
let stepsEl: HTMLOListElement | null = null;
let startHostEl: HTMLElement | null = null;
let rescanButton: HTMLButtonElement | null = null;
let repoRootsAdder: ReturnType<typeof createRepoRootsAdder> | null = null;
let currentState: FirstRunState = { steps: UPCOMING_STEPS, agentSummary: '', installableAgents: installableAgentsText(null), repoRoots: [], notificationChoice: 'ask', agentListing: null, startableProjects: [] };
let loadSequence = 0;
let hasRescanFoundNoAgent = false;
let hasTriedSavingFoundRoots = false;
const reportedStepKeys = new Set<string>();
const loadStatus = createActionStatus('first-run-load-status');
const startForm = createStartForm({ onAction: reportOnboardingAction });

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

function repoRootsStepBody(): HTMLElement[] {
  const adder = repoRootsAdder ?? createRepoRootsAdder({ onAdded: (source) => {
    reportOnboardingAction(source === 'typed' ? 'add-root-typed' : 'add-root-suggested');
    void loadFirstRunState({ rescanAgents: false });
  } });
  repoRootsAdder = adder;
  return [adder.element];
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
  sample.append(brandMark('first-run-sample-mark'), el('span', null, SAMPLE_NOTIFICATION_TEXT));
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

function renderSteps() {
  if (!stepsEl || !startHostEl) return;
  const { steps, agentSummary, repoRoots, notificationChoice } = currentState;
  stepsEl.replaceChildren(
    buildSetupStep({ title: '1. Agent CLI', state: steps.agent, summary: agentSummary, badge: '', body: agentStepBody }),
    buildSetupStep({ title: '2. Repository roots', state: steps.repoRoots, summary: repoRoots.join(', '), badge: '', body: repoRootsStepBody }),
    buildSetupStep({ title: '3. Notifications', state: steps.notifications, summary: notificationChoiceSummary(notificationChoice), badge: '', body: notificationsStepBody }),
  );
  const isStartShown = isSetupDone(steps);
  startHostEl.hidden = !isStartShown;
  if (!isStartShown) return;
  startForm.update({ agentListing: currentState.agentListing, startableProjects: currentState.startableProjects });
  if (!startHostEl.contains(startForm.element)) startHostEl.append(startForm.element);
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
    const foundRoots = rootsToAutoSave(repoRoots, suggestions);
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
    const steps = decideFirstRunSteps({ agentListing, repoRoots, notificationChoice });
    if (rescanAgents) hasRescanFoundNoAgent = steps.agent === 'current';
    currentState = { steps, agentSummary: agentSummaryText(agentListing), installableAgents: installableAgentsText(agentListing), repoRoots, notificationChoice, agentListing, startableProjects: isRootsScan ? startProjects(rootsScan.directories) : [] };
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

function brandMark(className: string): HTMLElement {
  const brackets = BRAND_MARK_BRACKETS.map(({ side, d }) => `<path class="first-run-mark-bracket" data-side="${side}" d="${d}"/>`).join('');
  return elWithMarkup('span', className, `<svg viewBox="${BRAND_MARK_VIEWBOX}" aria-hidden="true"><g class="first-run-mark-dial">${brackets}</g><path class="first-run-mark-light" d="${BRAND_MARK_LIGHT}"/></svg>`);
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
  lockup.append(brandMark('first-run-mark'), el('span', 'first-run-wordmark', 'GLIMMERVOID'));
  stepsEl = el('ol', 'first-run-steps');
  startHostEl = el('div', 'first-run-start-host');
  checklist.append(lockup, stepsEl, loadStatus.element, startHostEl);
  checklistEl = checklist;
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
