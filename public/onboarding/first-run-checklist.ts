import { sendControlRequest } from '../control-ws.ts';
import { createAddSessionDialog } from '../dialogs.ts';
import { el } from '../dom-helpers.ts';
import { createSettingsLink } from '../settings/settings-link.ts';
import { agentSummaryText, decideFirstRunSteps, UPCOMING_STEPS } from './first-run-checklist-core.ts';
import type { FirstRunStepState, FirstRunSteps } from './first-run-checklist-core.ts';
import { createRepoRootsAdder } from './repo-roots-adder.ts';

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

function agentStepBody(): HTMLElement[] {
  const actions = el('div', 'first-run-step-actions');
  rescanButton = el('button', 'btn-dialog btn-dialog-cancel', 'Rescan');
  rescanButton.type = 'button';
  rescanButton.addEventListener('click', () => { void loadFirstRunState({ rescanAgents: true }); });
  actions.append(rescanButton, el('span', 'first-run-step-hint', 'Any other terminal agent can be added under customAgents.'));
  return [
    el('p', 'first-run-step-text', 'No supported agent is on PATH. Install Claude Code, Codex or Grok, then rescan. Rescan still finding nothing means the CLI went into a folder the server cannot see: restart Glimmervoid from a terminal where the command runs.'),
    el('code', 'first-run-command', AGENT_INSTALL_COMMAND),
    actions,
  ];
}

function repoRootsStepBody(): HTMLElement[] {
  const adder = repoRootsAdder ?? createRepoRootsAdder({ onAdded: () => { void loadFirstRunState({ rescanAgents: false }); } });
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
  addSessionButton.addEventListener('click', createAddSessionDialog);
  const hint = el('span', 'first-run-step-hint', 'Folders and agents can change later in ');
  hint.append(createSettingsLink('machine-sessions', 'repository-roots', 'Settings > Sessions'), '.');
  actions.append(addSessionButton, hint);
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
      sendControlRequest('list-agents', rescanAgents ? { rescan: true } : {}),
      sendControlRequest('scan-repo-roots', { includeSuggestions: true }),
    ]);
    if (sequenceAtStart !== loadSequence) return;
    const isRootsScan = rootsScan.type === 'repo-roots-scanned';
    const repoRoots = isRootsScan ? rootsScan.directories.map((directory) => directory.root) : [];
    currentState = { steps: decideFirstRunSteps({ agentListing, repoRoots }), agentSummary: agentSummaryText(agentListing), repoRoots };
    renderSteps();
    repoRootsAdder?.setSuggestions(isRootsScan ? rootsScan.suggestions ?? [] : []);
  } catch {
    if (rescanButton) rescanButton.disabled = false;
  }
}

function ensureChecklist(): HTMLElement {
  if (checklistEl) return checklistEl;
  const checklist = el('section', 'first-run-checklist');
  checklist.setAttribute('aria-labelledby', 'first-run-title');
  const heading = el('h2', 'first-run-title', 'Get to your first session');
  heading.id = 'first-run-title';
  stepsEl = el('ol', 'first-run-steps');
  const footer = el('p', 'first-run-footer', 'This list goes away once a session exists. Something off? Run ');
  footer.append(el('code', null, 'glimmervoid doctor'), ' in a terminal.');
  checklist.append(
    el('span', 'first-run-eyebrow', 'FIRST RUN'),
    heading,
    el('p', 'first-run-intro', 'Glimmervoid runs the agent CLIs you already have, inside the repositories you point it at. Two checks, then start.'),
    stepsEl,
    footer,
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
  if (!wasShownHere) void loadFirstRunState({ rescanAgents: false });
}

export function refreshFirstRunChecklist() {
  if (!checklistEl || checklistEl.hidden || !checklistEl.isConnected) return;
  void loadFirstRunState({ rescanAgents: false });
}
