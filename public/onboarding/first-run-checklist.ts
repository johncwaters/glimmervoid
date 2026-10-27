import { createActionStatus, requestFailureText, DEFAULT_REPLY_TIMEOUT_MS } from '../action-status.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { openAddSessionDialog } from '../session-actions.ts';
import { el, writeClipboardText } from '../dom-helpers.ts';
import { isPhoneLayout } from '../form-factor.ts';
import { createNotificationPermissionControl } from '../notifications.ts';
import type { OperatorActionOf } from '#shared/contracts/control-messages.ts';
import { agentSummaryText, decideFirstRunSteps, decideOnboardingStepReports, onboardingStepReportKey, rootsToAutoSave, UPCOMING_STEPS } from './first-run-checklist-core.ts';
import type { FirstRunStepState, FirstRunSteps } from './first-run-checklist-core.ts';
import { createRepoRootsAdder, saveRepoRoots } from './repo-roots-adder.ts';

const AGENT_INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code';

const STEP_ICON_BY_STATE: Readonly<Record<FirstRunStepState, string>> = {
  done: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Done"><circle cx="12" cy="12" r="10"></circle><path d="M7.5 12.5l3 3 6-6.5"></path></svg>',
  current: '<svg width="18" height="18" viewBox="0 0 24 24" role="img" aria-label="Needed"><path d="M12 3l9 9-9 9-9-9z" fill="currentColor"></path></svg>',
  upcoming: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" role="img" aria-label="Not started"><circle cx="12" cy="12" r="10"></circle></svg>',
};

type FirstRunState = { steps: FirstRunSteps; agentSummary: string; repoRoots: string[] };

let checklistEl: HTMLElement | null = null;
let stepsEl: HTMLOListElement | null = null;
let rescanButton: HTMLButtonElement | null = null;
let repoRootsAdder: ReturnType<typeof createRepoRootsAdder> | null = null;
let currentState: FirstRunState = { steps: UPCOMING_STEPS, agentSummary: '', repoRoots: [] };
let loadSequence = 0;
let hasRescanFoundNoAgent = false;
let hasTriedSavingFoundRoots = false;
const reportedStepKeys = new Set<string>();
const loadStatus = createActionStatus('first-run-load-status');
const notificationPermissionControl = createNotificationPermissionControl();

function reportOnboardingAction(action: OperatorActionOf<'onboarding'>) {
  sendControlMsg({ type: 'dashboard-telemetry', event: 'operator_action', properties: { surface: 'onboarding', action } });
}

function reportOnboardingStepChanges(steps: FirstRunSteps) {
  for (const report of decideOnboardingStepReports(reportedStepKeys, steps)) {
    const isSent = sendControlMsg({ type: 'dashboard-telemetry', event: 'onboarding_step', properties: report });
    if (isSent) reportedStepKeys.add(onboardingStepReportKey(report));
  }
}

function buildStep({ title, state, summary, badge, body }: {
  title: string;
  state: FirstRunStepState;
  summary: string;
  badge: string;
  body: () => HTMLElement[];
}): HTMLLIElement {
  const step = el('li', 'first-run-step');
  step.dataset.state = state;
  if (state === 'current') step.setAttribute('aria-current', 'step');
  const head = el('div', 'first-run-step-head');
  const icon = el('span', 'first-run-step-icon');
  icon.innerHTML = STEP_ICON_BY_STATE[state];
  head.append(icon, el('span', 'first-run-step-title', title));
  if (state === 'done' && summary) head.append(el('span', 'first-run-step-summary', summary));
  if (state === 'current' && badge) head.append(el('span', 'first-run-step-badge', badge));
  step.append(head);
  if (state !== 'current') return step;
  const stepBody = el('div', 'first-run-step-body');
  stepBody.append(...body());
  step.append(stepBody);
  return step;
}

function agentStepLeadText(): string {
  if (isPhoneLayout()) return 'No supported agent is on PATH of the machine running Glimmervoid. Install Claude Code, Codex or Grok there, then rescan.';
  return 'No supported agent is on PATH. Install Claude Code, Codex or Grok, then rescan.';
}

function installCommandRow(): HTMLElement {
  const row = el('div', 'first-run-command-row');
  row.append(el('code', 'first-run-command', AGENT_INSTALL_COMMAND));
  if (!navigator.clipboard?.writeText) return row;
  const copyButton = el('button', 'btn-dialog btn-dialog-cancel', 'Copy');
  copyButton.type = 'button';
  const copyStatus = el('span', 'first-run-copy-status');
  copyStatus.setAttribute('role', 'status');
  copyButton.addEventListener('click', async () => {
    const write = writeClipboardText(AGENT_INSTALL_COMMAND);
    copyStatus.textContent = write ? await write.then(() => 'Copied', () => 'Copy failed') : 'Copy failed';
  });
  row.append(copyButton, copyStatus);
  return row;
}

function agentStepBody(): HTMLElement[] {
  const actions = el('div', 'first-run-step-actions');
  rescanButton = el('button', 'btn-dialog btn-dialog-cancel', 'Rescan');
  rescanButton.type = 'button';
  rescanButton.addEventListener('click', () => {
    reportOnboardingAction('rescan');
    void loadFirstRunState({ rescanAgents: true });
  });
  actions.append(rescanButton);
  const body = [el('p', 'first-run-step-text', agentStepLeadText()), installCommandRow(), actions];
  if (!hasRescanFoundNoAgent) return body;
  return [...body, el('p', 'first-run-step-hint', 'Still missing after a rescan? Restart Glimmervoid from a terminal where the command runs. Other terminal agents go under customAgents.')];
}

function repoRootsStepBody(): HTMLElement[] {
  const adder = repoRootsAdder ?? createRepoRootsAdder({ onAdded: (source) => {
    reportOnboardingAction(source === 'typed' ? 'add-root-typed' : 'add-root-suggested');
    void loadFirstRunState({ rescanAgents: false });
  } });
  repoRootsAdder = adder;
  return [
    el('p', 'first-run-step-text', 'The folder that holds your git checkouts. Each subfolder becomes a project you can start a session in.'),
    adder.element,
  ];
}

function firstSessionStepBody(): HTMLElement[] {
  const actions = el('div', 'first-run-step-actions');
  const addSessionButton = el('button', 'btn-dialog btn-dialog-confirm', '+ Session');
  addSessionButton.type = 'button';
  addSessionButton.addEventListener('click', () => {
    reportOnboardingAction('add-session');
    openAddSessionDialog();
  });
  actions.append(addSessionButton);
  return [
    el('p', 'first-run-step-text', 'Pick a project and an agent. The session runs in its own git worktree, so your checkout is never touched.'),
    actions,
  ];
}

function renderSteps() {
  if (!stepsEl) return;
  const { steps, agentSummary, repoRoots } = currentState;
  stepsEl.replaceChildren(
    buildStep({ title: '1. Agent CLI', state: steps.agent, summary: agentSummary, badge: 'MISSING', body: agentStepBody }),
    buildStep({ title: '2. Repository roots', state: steps.repoRoots, summary: repoRoots.join(', '), badge: 'NEEDED', body: repoRootsStepBody }),
    buildStep({ title: '3. First session', state: steps.firstSession, summary: '', badge: '', body: firstSessionStepBody }),
  );
}

async function loadFirstRunState({ rescanAgents }: { rescanAgents: boolean }) {
  loadSequence += 1;
  const sequenceAtStart = loadSequence;
  if (rescanButton) rescanButton.disabled = true;
  try {
    const [agentListing, rootsScan] = await Promise.all([
      sendControlRequest('list-agents', rescanAgents ? { rescan: true } : {}, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS }),
      sendControlRequest('scan-repo-roots', { includeSuggestions: true }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS }),
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
    const steps = decideFirstRunSteps({ agentListing, repoRoots });
    if (rescanAgents) hasRescanFoundNoAgent = steps.agent === 'current';
    currentState = { steps, agentSummary: agentSummaryText(agentListing), repoRoots };
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

function ensureChecklist(): HTMLElement {
  if (checklistEl) return checklistEl;
  const checklist = el('section', 'first-run-checklist');
  checklist.setAttribute('aria-labelledby', 'first-run-title');
  const heading = el('h2', 'first-run-title', 'Get to your first session');
  heading.id = 'first-run-title';
  stepsEl = el('ol', 'first-run-steps');
  const optionalGroup = el('div', 'first-run-optional');
  optionalGroup.append(el('span', 'first-run-eyebrow', 'OPTIONAL'), notificationPermissionControl.element);
  checklist.append(
    el('span', 'first-run-eyebrow', 'FIRST RUN'),
    heading,
    stepsEl,
    loadStatus.element,
    optionalGroup,
  );
  checklistEl = checklist;
  renderSteps();
  return checklist;
}

export function showFirstRunChecklist(host: HTMLElement, isShown: boolean) {
  if (!isShown) {
    if (checklistEl?.parentElement === host) checklistEl.hidden = true;
    return;
  }
  const checklist = ensureChecklist();
  const wasShownHere = !checklist.hidden && checklist.parentElement === host;
  if (checklist.parentElement !== host) host.append(checklist);
  checklist.hidden = false;
  notificationPermissionControl.refresh();
  if (!wasShownHere) void loadFirstRunState({ rescanAgents: false });
}

export function refreshFirstRunChecklist() {
  if (!checklistEl || checklistEl.hidden || !checklistEl.isConnected) return;
  void loadFirstRunState({ rescanAgents: false });
}
