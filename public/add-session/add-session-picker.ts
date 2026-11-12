import addSessionHTML from '../components/add-session-dialog.html?raw';
import { createActionStatus, DEFAULT_REPLY_TIMEOUT_MS, requestFailureText } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import { agentAccountsOf, onAgentAccountsChanged, refreshAgentAccounts } from '../agent-logins.ts';
import { el, query, queryTag } from '../dom-helpers.ts';
import { createRepoRootsAdder } from '../onboarding/repo-roots-adder.ts';
import { button } from '../ui/button.ts';
import { createPressable } from '../ui/pressable.ts';
import { buildRepoCheckbox } from '../session-card/workspace-repos-dialog.ts';
import { DEFAULT_AGENT_ID, SHELL_AGENT_ID, decideAgentAvailability, decideAgentPicker } from '../session-card/agent-core.ts';
import { paintAgentChoiceMark } from '../session-card/agent-mark.ts';
import { suggestSessionName } from '../session-card/naming.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { needsAttention } from '../focus-view/attention-core.ts';
import { STATES } from '#shared/states.ts';
import { elapsedText } from '#shared/display-text.ts';
import { getAddSessionStarts, setAddSessionStarts } from '../ui-prefs.ts';
import { decidePermissions, filterRows, lastPathSegment, orderRecentRows, rememberStart, sessionNameBase } from '../add-session-core.ts';
import type { LiveSession, RecentRow, ScannedProject } from '../add-session-core.ts';
import { addSessionRefusalText, revealAddedSession } from '../session-actions.ts';
import { clock } from '#shared/clock.ts';
import type { ApprovedPackLauncher } from '#shared/contracts/control/pack-messages.ts';
import { packsSnapshot, subscribePacks } from '../packs/packs-store.ts';

function formatRelativeAge(receivedAt: number, now: number): string {
  const elapsedMs = now - receivedAt;
  if (!Number.isFinite(elapsedMs)) return 'just now';
  return elapsedText(elapsedMs, { rounding: 'floor', wording: 'abbreviated', suffix: ' ago', justNowBelowSeconds: 60 });
}

const NO_AGENT_ID = '';

function isSaneYoloAvailable(settings: unknown): boolean {
  if (typeof settings !== 'object' || settings === null) return false;
  return 'saneYoloAvailable' in settings && settings.saneYoloAvailable === true;
}

type AddSessionTarget =
  | { kind: 'none' }
  | { kind: 'project'; row: RecentRow }
  | { kind: 'workspace' }
  | { kind: 'folder' };

type AddSessionRequest = { message: Record<string, unknown>; rememberedPath: string | null; requestType?: 'add-session' | 'pack-launch' };

type AddSessionSlot = 'agent' | 'project';

const ADD_SESSION_SLOTS: readonly AddSessionSlot[] = ['agent', 'project'];
const NO_TARGET: AddSessionTarget = { kind: 'none' };
const UNPROTECTED_ASKS_TEXT = 'Sane YOLO is not available here, so the agent asks before acting.';
const UNPROTECTED_SKIPS_TEXT = 'Sane YOLO is not available here, so this session skips permission prompts unprotected.';

function liveSessionsByPath(): LiveSession[] {
  return [...sessionUIs.values()].map((ui) => ({
    path: ui.path,
    isRunning: ui.currentState === STATES.RUNNING,
    isWaiting: needsAttention({ state: ui.currentState, unseenOutcome: ui.unseenOutcome }),
  }));
}

function scannedProjectsOf(message: ServerMessage): ScannedProject[] {
  if (message.type !== 'repo-roots-scanned') return [];
  return message.directories.flatMap((directory) => directory.projects.map(({ name, path, lastActivityMs }) => ({ name, path, lastActivityMs })));
}

function settingFlag(settings: unknown, key: string): boolean | null {
  if (typeof settings !== 'object' || settings === null || !(key in settings)) return null;
  const value: unknown = Reflect.get(settings, key);
  return typeof value === 'boolean' ? value : null;
}

function liveCountText(row: RecentRow): HTMLElement | null {
  const counts = [
    { count: row.runningCount, label: 'running', tone: 'running' },
    { count: row.waitingCount, label: 'waiting', tone: 'waiting' },
  ].filter(({ count }) => count > 0);
  if (counts.length === 0) return null;
  const meta = el('span', 'add-session-row-meta');
  for (const { count, label, tone } of counts) {
    const part = el('span', 'add-session-row-count');
    part.dataset.tone = tone;
    part.textContent = `${count} ${label}`;
    meta.append(part);
  }
  return meta;
}

function cancelButtons(onCancel: (() => void) | undefined): HTMLButtonElement[] {
  if (!onCancel) return [];
  const btnCancel = button({ variant: 'secondary', label: 'Cancel' });
  btnCancel.addEventListener('click', onCancel);
  return [btnCancel];
}

function buildTaskField(initialTask: string) {
  const field = el('label', 'dialog-label add-session-task-field', 'First task');
  const taskInput = el('textarea', 'dialog-input add-session-task');
  taskInput.value = initialTask;
  taskInput.maxLength = 4000;
  taskInput.spellcheck = false;
  field.append(taskInput);
  return { field, taskInput };
}

type AddSessionPickerOptions = { onStarted: () => void; onCancel?: () => void; initialTask?: string };

export function mountAddSessionPicker(dialog: HTMLElement, { onStarted, onCancel, initialTask }: AddSessionPickerOptions) {
  dialog.innerHTML = addSessionHTML;
  const taskField = initialTask === undefined ? null : buildTaskField(initialTask);
  if (taskField) query(dialog, '#add-session-unprotected').before(taskField.field);

  const pickEl = query(dialog, '#add-session-pick');
  const findInput = queryTag(dialog, '#add-session-find', 'input');
  const listEl = query(dialog, '#add-session-list');
  const repoRootsEl = query(dialog, '#add-session-repo-roots');
  const repoRootsTitleEl = query(dialog, '#add-session-repo-roots-title');
  const workspacePanel = query(dialog, '#add-session-workspace');
  const workspaceListEl = query(dialog, '#add-session-workspace-list');
  const folderPanel = query(dialog, '#add-session-folder');
  const pathInput = queryTag(dialog, '#add-session-path', 'input');
  const accountEl = query(dialog, '#add-session-account');
  const accountSelect = queryTag(dialog, '#add-session-account-select', 'select');
  const unprotectedHintEl = query(dialog, '#add-session-unprotected');
  const errorEl = query(dialog, '#add-session-error');
  const launchersEl = query(dialog, '#add-session-launchers');
  const agentWord = createPressable('add-session-word');
  const agentMarkEl = el('span', 'agent-mark');
  agentMarkEl.setAttribute('aria-hidden', 'true');
  agentMarkEl.hidden = true;
  const agentWordTextEl = el('span', '', 'an agent');
  agentWord.append(agentMarkEl, agentWordTextEl);
  query(dialog, '#add-session-agent-word-slot').replaceWith(agentWord);
  const repoWord = createPressable('add-session-word add-session-repo-word');
  query(dialog, '#add-session-repo-word-slot').replaceWith(repoWord);
  const wordBySlot: Record<AddSessionSlot, HTMLButtonElement> = { agent: agentWord, project: repoWord };
  const workspaceBackButton = createPressable('add-session-back', 'All projects');
  query(dialog, '#add-session-workspace-back-slot').replaceWith(workspaceBackButton);
  const folderBackButton = createPressable('add-session-back', 'All projects');
  query(dialog, '#add-session-folder-back-slot').replaceWith(folderBackButton);
  const startStatus = createActionStatus('dialog-hint');
  const btnConfirm = button({ variant: 'primary', label: 'Start session' });
  query(dialog, '#add-session-actions').append(startStatus.element, ...cancelButtons(onCancel), btnConfirm);

  const rememberedStarts = getAddSessionStarts();
  let target: AddSessionTarget = NO_TARGET;
  let lastProjectTarget: AddSessionTarget = NO_TARGET;
  let scannedProjects: ScannedProject[] = [];
  let recentRows: RecentRow[] = [];
  let agentOptions: { id: string; label: string }[] = [];
  let defaultAgentId = DEFAULT_AGENT_ID;
  let selectedAgentId = NO_AGENT_ID;
  let hasSettingsLoaded = false;
  let settingsLoadCount = 0;
  let agentsLoadCount = 0;
  let agentWarningEl: HTMLElement | null = null;
  let settingsWarningEl: HTMLElement | null = null;
  let isSaneYoloInstalled = false;
  let isSaneYoloSettingOn = true;
  let skipsPermissionsByDefault = false;
  let isSpawnBlocked = false;
  let isAddPending = false;
  let isAgentListSettled = false;
  let openSlot: AddSessionSlot | null = null;
  let operatorTouch: 'untouched' | 'acted' | 'reopened' = 'untouched';
  let operatorAccountChoice: { agentId: string; accountId: string } | null = null;

  function requestControl(type: string, payload: Record<string, unknown>) {
    return sendControlRequest(type, payload, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
  }

  const isShellChosen = () => selectedAgentId === SHELL_AGENT_ID;
  const agentLabelOf = (agentId: string) => agentOptions.find((agentOption) => agentOption.id === agentId)?.label ?? null;
  const pickAgentId = (rememberedAgentId: string | null) => {
    if (rememberedAgentId === null || rememberedAgentId === SHELL_AGENT_ID) return defaultAgentId;
    return agentOptions.some((agentOption) => agentOption.id === rememberedAgentId) ? rememberedAgentId : defaultAgentId;
  };

  const isSlotEmpty: Record<AddSessionSlot, () => boolean> = {
    agent: () => selectedAgentId === NO_AGENT_ID && (!isAgentListSettled || agentOptions.length > 0),
    project: () => target.kind === 'none',
  };
  const firstEmptySlot = () => ADD_SESSION_SLOTS.find((slot) => isSlotEmpty[slot]()) ?? null;

  function renderSentence() {
    const wordByKind: Record<AddSessionTarget['kind'], string> = {
      none: 'a project',
      project: target.kind === 'project' ? target.row.name : '',
      workspace: 'several repos',
      folder: lastPathSegment(pathInput.value.trim()) || 'a folder',
    };
    repoWord.textContent = wordByKind[target.kind];
    agentWordTextEl.textContent = agentLabelOf(selectedAgentId) ?? 'an agent';
    for (const slot of ADD_SESSION_SLOTS) wordBySlot[slot].setAttribute('aria-expanded', String(openSlot === slot));
    pickEl.hidden = openSlot === null;
    if (openSlot) pickEl.dataset.slot = openSlot;
    workspacePanel.hidden = openSlot !== null || target.kind !== 'workspace';
    folderPanel.hidden = openSlot !== null || target.kind !== 'folder';
  }

  function buildSlotRow(key: string, name: string, isPicked: boolean, onPick: () => void) {
    const rowEl = createPressable('add-session-row');
    rowEl.setAttribute('role', 'option');
    rowEl.setAttribute('aria-selected', String(isPicked));
    rowEl.dataset.key = key;
    rowEl.append(el('span', 'add-session-row-name', name));
    rowEl.addEventListener('click', () => {
      markOperatorActed();
      onPick();
    });
    return rowEl;
  }

  function buildAgentMark(agentId: string) {
    const markEl = el('span', 'agent-mark');
    markEl.setAttribute('aria-hidden', 'true');
    paintAgentChoiceMark(markEl, agentId, agentLabelOf(agentId));
    return markEl;
  }

  function buildChoiceRow(label: string, onPick: () => void) {
    const row = createPressable('add-session-row add-session-row-choice');
    row.dataset.key = label;
    row.append(el('span', 'add-session-row-name', label), el('span', 'add-session-row-chevron'));
    row.addEventListener('click', () => {
      markOperatorActed();
      onPick();
    });
    return row;
  }

  function buildProjectRow(row: RecentRow) {
    const isPicked = target.kind === 'project' && target.row.path === row.path;
    const rowEl = buildSlotRow(row.path, row.name, isPicked, () => {
      setProjectTarget(row);
      advanceFromPick(true);
    });
    const meta = liveCountText(row) ?? (row.lastActivityMs !== null ? el('span', 'add-session-row-meta', formatRelativeAge(row.lastActivityMs, clock.nowMs())) : null);
    if (meta) rowEl.append(meta);
    return rowEl;
  }

  function buildAgentRow(agentOption: { id: string; label: string }) {
    const rowEl = buildSlotRow(agentOption.id, agentOption.label, agentOption.id === selectedAgentId, () => {
      const targetBeforePick = target;
      setAgent(agentOption.id);
      advanceFromPick(target === targetBeforePick);
    });
    rowEl.prepend(buildAgentMark(agentOption.id));
    return rowEl;
  }

  function buildProjectRows() {
    const rows: HTMLElement[] = filterRows(recentRows, findInput.value).map(buildProjectRow);
    if (!isShellChosen() && scannedProjects.length >= 2) rows.push(buildChoiceRow('Several repos', pickWorkspace));
    rows.push(buildChoiceRow('Any folder', pickFolder));
    return rows;
  }

  function renderList() {
    const focusedRowKey = document.activeElement instanceof HTMLElement && listEl.contains(document.activeElement) ? document.activeElement.dataset.key ?? null : null;
    renderSentence();
    if (openSlot === 'agent') listEl.replaceChildren(...agentOptions.map(buildAgentRow));
    if (openSlot === 'project') listEl.replaceChildren(...buildProjectRows());
    if (focusedRowKey !== null) [...listEl.querySelectorAll<HTMLElement>('.add-session-row')].find((rowEl) => rowEl.dataset.key === focusedRowKey)?.focus();
  }

  function isFocusAdrift() {
    const focused = document.activeElement;
    return focused === null || focused === document.body || focused === dialog || ADD_SESSION_SLOTS.some((slot) => wordBySlot[slot] === focused);
  }

  function focusOpenSlot() {
    if (openSlot === null) {
      focusAfterLastSlot();
      return;
    }
    if (document.documentElement.dataset.layout === 'phone') {
      dialog.focus();
      return;
    }
    if (openSlot === 'project') {
      findInput.focus();
      return;
    }
    listEl.querySelector<HTMLElement>('.add-session-row:not(:disabled)')?.focus();
  }

  function focusAfterLastSlot() {
    if (target.kind === 'workspace') {
      workspaceBackButton.focus();
      return;
    }
    if (target.kind === 'folder') {
      pathInput.focus();
      return;
    }
    btnConfirm.focus();
  }

  function openSlotList(slot: AddSessionSlot | null) {
    openSlot = slot;
    renderList();
    focusOpenSlot();
  }

  function markOperatorActed() {
    if (operatorTouch === 'untouched') operatorTouch = 'acted';
  }

  function advance() {
    if (operatorTouch === 'reopened') operatorTouch = 'acted';
    openSlotList(firstEmptySlot());
  }

  function canStartOnPick() {
    return firstEmptySlot() === null && target.kind === 'project' && selectedAgentId !== NO_AGENT_ID && hasSettingsLoaded && !isSpawnBlocked;
  }

  function advanceFromPick(isTargetChosenByOperator: boolean) {
    if (!isTargetChosenByOperator || !canStartOnPick()) {
      advance();
      return;
    }
    if (operatorTouch === 'reopened') operatorTouch = 'acted';
    renderList();
    submit();
  }

  function settleOpenSlot() {
    if (operatorTouch !== 'untouched' && pickEl.contains(document.activeElement)) {
      renderList();
      return;
    }
    const isOpenSlotDone = openSlot === null ? firstEmptySlot() !== null : operatorTouch !== 'reopened' && !isSlotEmpty[openSlot]();
    const isUntouchedReorder = operatorTouch === 'untouched' && openSlot !== firstEmptySlot();
    if (isOpenSlotDone || isUntouchedReorder) {
      advance();
      return;
    }
    renderList();
    if (operatorTouch !== 'reopened' && isFocusAdrift()) focusOpenSlot();
  }

  function setProjectTarget(row: RecentRow) {
    target = { kind: 'project', row };
    lastProjectTarget = target;
    errorEl.textContent = '';
  }

  function pickWorkspace() {
    target = { kind: 'workspace' };
    errorEl.textContent = '';
    workspaceListEl.replaceChildren(...scannedProjects.map((project) => buildRepoCheckbox(project.name, project.path)));
    advance();
  }

  function pickFolder() {
    target = { kind: 'folder' };
    errorEl.textContent = '';
    advance();
  }

  function returnToProjects() {
    target = lastProjectTarget;
    openSlot = 'project';
    renderList();
  }

  function rebuildRows() {
    recentRows = orderRecentRows(scannedProjects, rememberedStarts, liveSessionsByPath(), pickAgentId);
    const pickedPath = target.kind === 'project' ? target.row.path : null;
    const pickedRow = recentRows.find((row) => row.path === pickedPath) ?? null;
    if (pickedRow) setProjectTarget(pickedRow);
    renderList();
  }

  function renderPermissionHint() {
    const choice = decidePermissions({ isSaneYoloInstalled, isSaneYoloSettingOn, isShell: isShellChosen() });
    unprotectedHintEl.hidden = !hasSettingsLoaded || !choice.isUnprotectedHintShown;
    unprotectedHintEl.textContent = skipsPermissionsByDefault ? UNPROTECTED_SKIPS_TEXT : UNPROTECTED_ASKS_TEXT;
  }

  function setAgent(agentId: string) {
    selectedAgentId = agentId;
    paintAgentChoiceMark(agentMarkEl, agentId === NO_AGENT_ID ? null : agentId, agentLabelOf(agentId));
    applyAgentRules();
    renderSentence();
  }

  function applyAgentRules() {
    const isShell = isShellChosen();
    if (isShell && target.kind === 'workspace') returnToProjects();
    renderPermissionHint();
    showAccountPick();
  }

  function pickableAccounts() {
    const accounts = agentAccountsOf(selectedAgentId).filter((account) => !account.isPending);
    return accounts.some((account) => account.accountId !== null) ? accounts : [];
  }

  function showAccountPick() {
    if (!dialog.isConnected) {
      unsubscribeAgentAccounts();
      return;
    }
    const accounts = pickableAccounts();
    accountEl.hidden = accounts.length === 0;
    const optionValueOf = (accountId: string | null) => accountId ?? '';
    const chosenValue = operatorAccountChoice?.agentId === selectedAgentId ? operatorAccountChoice.accountId : null;
    const defaultValue = optionValueOf(accounts.find((account) => account.isDefault)?.accountId ?? null);
    accountSelect.replaceChildren(...accounts.map((account) => {
      const stateText = account.login.state === 'signed-out' ? ' (signed out)' : '';
      const option = el('option', '', `${account.label}${account.accountId === null ? ', this machine' : ''}${stateText}`);
      option.value = optionValueOf(account.accountId);
      return option;
    }));
    const isChosenListed = chosenValue !== null && accounts.some((account) => optionValueOf(account.accountId) === chosenValue);
    accountSelect.value = isChosenListed ? chosenValue : defaultValue;
  }
  accountSelect.addEventListener('change', () => {
    markOperatorActed();
    operatorAccountChoice = { agentId: selectedAgentId, accountId: accountSelect.value };
  });
  const unsubscribeAgentAccounts = onAgentAccountsChanged(showAccountPick);
  refreshAgentAccounts();

  for (const slot of ADD_SESSION_SLOTS) {
    wordBySlot[slot].addEventListener('click', () => {
      operatorTouch = 'reopened';
      openSlotList(slot);
    });
  }

  const repoRootsAdder = createRepoRootsAdder({ onAdded: fillProjectList });
  repoRootsEl.append(repoRootsAdder.element);
  const scanStatus = createActionStatus('dialog-hint');
  const btnScanAgain = button({ variant: 'secondary', label: 'Scan again', hidden: true });
  btnScanAgain.addEventListener('click', () => { void fillProjectList(); });
  const scanRow = el('div', 'flex items-center gap-2');
  scanRow.append(scanStatus.element, btnScanAgain);
  repoRootsEl.before(scanRow);

  function showScanFailure(reason: string) {
    scannedProjects = [];
    recentRows = [];
    renderList();
    scanStatus.show('error', `The project scan failed: ${reason}`);
    btnScanAgain.hidden = false;
    btnScanAgain.disabled = false;
  }

  function showRepoRootsAdder(message: ServerMessage) {
    const isScan = message.type === 'repo-roots-scanned';
    repoRootsTitleEl.textContent = isScan && message.directories.length > 0 ? 'No projects in your repository roots yet' : 'No repository roots yet';
    repoRootsAdder.setSuggestions(isScan ? message.suggestions ?? [] : []);
    repoRootsEl.hidden = false;
  }

  function fillProjectList() {
    btnScanAgain.disabled = true;
    scanStatus.show('busy', 'Scanning your repository roots');
    return requestControl('scan-repo-roots', { includeSuggestions: true, includeActivity: true })
      .then((message: ServerMessage) => {
        if (message.type === 'repo-roots-scanned' && message.error) { showScanFailure(message.error); return; }
        scanStatus.clear();
        btnScanAgain.hidden = true;
        repoRootsEl.hidden = true;
        scannedProjects = scannedProjectsOf(message);
        rebuildRows();
        if (scannedProjects.length === 0) showRepoRootsAdder(message);
      })
      .catch((reason: unknown) => { showScanFailure(requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS)); });
  }

  findInput.addEventListener('input', () => {
    markOperatorActed();
    const visibleRows = filterRows(recentRows, findInput.value);
    const pickedPath = target.kind === 'project' ? target.row.path : null;
    const isPickVisible = visibleRows.some((row) => row.path === pickedPath);
    if (!isPickVisible && visibleRows[0]) setProjectTarget(visibleRows[0]);
    renderList();
  });

  for (const backButton of [workspaceBackButton, folderBackButton]) {
    backButton.addEventListener('click', () => {
      returnToProjects();
      focusOpenSlot();
    });
  }
  pathInput.addEventListener('input', renderSentence);

  function showWarning(text: string) {
    const warningEl = el('p', 'dialog-hint dialog-hint-warning', text);
    warningEl.setAttribute('role', 'status');
    errorEl.before(warningEl);
    return warningEl;
  }
  function clearAgentWarning() {
    agentWarningEl?.remove();
    agentWarningEl = null;
  }

  function applySpawnAvailability(availability: ReturnType<typeof decideAgentAvailability>) {
    clearAgentWarning();
    isSpawnBlocked = !availability.canSpawn;
    btnConfirm.disabled = isSpawnBlocked || isAddPending;
    if (availability.canSpawn) return;
    agentWarningEl = showWarning(availability.guidance);
    agentWarningEl.id = 'add-session-agent-guidance';
  }

  function loadAgents() {
    agentsLoadCount += 1;
    const agentsLoadNumber = agentsLoadCount;
    const whileLatestAgents = <Value>(apply: (value: Value) => void) => (value: Value) => {
      if (agentsLoadNumber === agentsLoadCount) apply(value);
    };
    return requestControl('list-agents', {})
      .then(whileLatestAgents((message: ServerMessage) => {
        applySpawnAvailability(decideAgentAvailability(message));
        const decision = decideAgentPicker(message.type === 'agents-listed' ? message.agents : []);
        agentOptions = decision.options;
        defaultAgentId = decision.selectedId;
        isAgentListSettled = true;
        setAgent(agentOptions.some((agentOption) => agentOption.id === selectedAgentId) ? selectedAgentId : NO_AGENT_ID);
        rebuildRows();
        settleOpenSlot();
      }))
      .catch(whileLatestAgents((reason: unknown) => {
        if (isAgentListSettled) return;
        isAgentListSettled = true;
        clearAgentWarning();
        agentWarningEl = showWarning(`Could not load the agent list (${requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS)}), so the session uses the default agent.`);
        settleOpenSlot();
      }));
  }

  function clearSettingsWarning() {
    settingsWarningEl?.remove();
    settingsWarningEl = null;
  }

  function failSettingsClosed(warning: string) {
    hasSettingsLoaded = false;
    renderPermissionHint();
    clearSettingsWarning();
    settingsWarningEl = showWarning(warning);
  }

  function loadSettings() {
    hasSettingsLoaded = false;
    renderPermissionHint();
    settingsLoadCount += 1;
    const settingsLoadNumber = settingsLoadCount;
    const whileLatestSettings = <Value>(apply: (value: Value) => void) => (value: Value) => {
      if (settingsLoadNumber === settingsLoadCount) apply(value);
    };
    return requestControl('get-settings', {})
      .then(whileLatestSettings((message: ServerMessage) => {
        if (message.type === 'settings-error') {
          failSettingsClosed(`Could not load your settings (${message.message}), so the session follows your machine permission setting.`);
          return;
        }
        if (message.type !== 'settings') return;
        isSaneYoloInstalled = isSaneYoloAvailable(message.settings);
        isSaneYoloSettingOn = settingFlag(message.settings, 'saneYolo') !== false;
        skipsPermissionsByDefault = settingFlag(message.settings, 'skipPermissionsByDefault') === true;
        hasSettingsLoaded = true;
        clearSettingsWarning();
        renderPermissionHint();
      }))
      .catch(whileLatestSettings((reason: unknown) => {
        failSettingsClosed(`Could not load your settings (${requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS)}), so the session follows your machine permission setting.`);
      }));
  }

  function permissionFields() {
    if (!hasSettingsLoaded) return { dangerouslySkipPermissions: false };
    return decidePermissions({ isSaneYoloInstalled, isSaneYoloSettingOn, isShell: isShellChosen() }).fields;
  }

  function buildRequest(): AddSessionRequest | null {
    if (selectedAgentId === NO_AGENT_ID && agentOptions.length > 0) {
      errorEl.textContent = 'Pick an agent.';
      return null;
    }
    const isShell = isShellChosen();
    const shared: Record<string, unknown> = { ...permissionFields() };
    if (selectedAgentId !== NO_AGENT_ID && selectedAgentId !== DEFAULT_AGENT_ID) shared.agent = selectedAgentId;
    if (!accountEl.hidden) shared.accountId = accountSelect.value === '' ? null : accountSelect.value;
    const task = taskField?.taskInput.value.trim() ?? '';
    if (task && !isShell) shared.prompt = task;
    if (target.kind === 'project') {
      return { message: { ...shared, name: suggestSessionName(sessionNameBase(target.row.name)), path: target.row.path }, rememberedPath: isShell ? null : target.row.path };
    }
    if (target.kind === 'workspace') {
      const repos = [...workspaceListEl.querySelectorAll<HTMLInputElement>('input:checked')].map((checkbox) => checkbox.value);
      if (repos.length < 2) {
        errorEl.textContent = 'Check at least two repositories.';
        return null;
      }
      return { message: { ...shared, name: suggestSessionName(sessionNameBase(lastPathSegment(repos[0]))), path: repos[0], repos }, rememberedPath: null };
    }
    if (target.kind === 'folder') {
      const folderPath = pathInput.value.trim();
      if (!folderPath && !isShell) {
        errorEl.textContent = 'Enter a folder path.';
        return null;
      }
      return { message: { ...shared, name: suggestSessionName(sessionNameBase(folderPath ? lastPathSegment(folderPath) : SHELL_AGENT_ID)), path: folderPath }, rememberedPath: null };
    }
    errorEl.textContent = 'Pick a project.';
    return null;
  }

  function submit() {
    if (isSpawnBlocked || isAddPending) return;
    errorEl.textContent = '';
    const request = buildRequest();
    if (request) requestAddSession(request);
  }

  function rememberSuccessfulStart(rememberedPath: string | null) {
    if (rememberedPath === null) return;
    setAddSessionStarts(rememberStart(getAddSessionStarts(), rememberedPath, selectedAgentId === NO_AGENT_ID ? defaultAgentId : selectedAgentId, clock.nowMs()));
  }

  function lockPicking(isLocked: boolean) {
    const pickingRegions = [pickEl, workspacePanel, folderPanel, launchersEl];
    if (isLocked && pickingRegions.some((region) => region.contains(document.activeElement))) dialog.focus();
    for (const region of pickingRegions) region.inert = isLocked;
    for (const slot of ADD_SESSION_SLOTS) wordBySlot[slot].disabled = isLocked;
  }

  function buildLauncher(launcher: ApprovedPackLauncher) {
    const launcherEl = el('div', 'add-session-launcher');
    const launchButton = button({ variant: 'secondary', label: launcher.label });
    launchButton.disabled = launcher.disabledReason !== null;
    launchButton.addEventListener('click', () => {
      if (isSpawnBlocked || isAddPending) return;
      errorEl.textContent = '';
      requestAddSession({ message: { pack: launcher.pack, launcherId: launcher.id }, rememberedPath: null, requestType: 'pack-launch' });
    });
    launcherEl.append(launchButton, el('span', 'dialog-hint', launcher.disabledReason ?? `${launcher.agent} in ${launcher.project}`));
    return launcherEl;
  }

  function renderLaunchers() {
    const launchers = packsSnapshot()?.launchers ?? [];
    launchersEl.hidden = launchers.length === 0;
    launchersEl.replaceChildren(...launchers.map(buildLauncher));
  }

  function requestAddSession({ message, rememberedPath, requestType = 'add-session' }: AddSessionRequest) {
    isAddPending = true;
    btnConfirm.disabled = true;
    lockPicking(true);
    startStatus.show('busy', 'Starting the session');
    const showRefusal = (text: string) => { errorEl.textContent = text; };
    requestControl(requestType, message)
      .then((reply) => {
        if (reply.type === 'add-session-result' && reply.ok) {
          rememberSuccessfulStart(rememberedPath);
          onStarted();
          revealAddedSession(reply.sessionId);
          return;
        }
        showRefusal(addSessionRefusalText(reply));
      })
      .catch((reason) => { showRefusal(`The session was not added: ${requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS)}`); })
      .finally(() => {
        isAddPending = false;
        startStatus.clear();
        btnConfirm.disabled = isSpawnBlocked;
        lockPicking(false);
        if (dialog.isConnected && isFocusAdrift()) focusOpenSlot();
      });
  }

  btnConfirm.addEventListener('click', submit);
  pathInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
  findInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || target.kind !== 'project') return;
    event.preventDefault();
    const pickedPath = target.row.path;
    advanceFromPick(filterRows(recentRows, findInput.value).some((row) => row.path === pickedPath));
  });

  const stopWatchingPacks = subscribePacks(() => {
    if (!dialog.isConnected) {
      stopWatchingPacks();
      return;
    }
    renderLaunchers();
  });
  renderLaunchers();
  advance();
  refresh();

  function refresh() {
    void fillProjectList();
    void loadAgents();
    void loadSettings();
  }

  return { refresh };
}
