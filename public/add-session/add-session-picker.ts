import addSessionHTML from '../components/add-session-dialog.html?raw';
import { createActionStatus, DEFAULT_REPLY_TIMEOUT_MS, requestFailureText } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { settingsPayloadSnapshot } from '../settings/settings-store.ts';
import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import { agentAccountSummary, agentAccountsOf, onAgentAccountsChanged, refreshAgentAccounts } from '../agent-logins.ts';
import { el, markAsNotCredential, query, queryTag } from '../dom-helpers.ts';
import { createRepoRootsAdder } from '../onboarding/repo-roots-adder.ts';
import { cloneJobOf, cloneJobStatusText, isCloneJobUnsettled, onCloneJobsChanged, requestGithubRepos, requestRepositoryClones } from '../onboarding/clone-jobs.ts';
import type { GithubRepo } from '../onboarding/clone-jobs.ts';
import { button } from '../ui/button.ts';
import { createPressable } from '../ui/pressable.ts';
import { DEFAULT_AGENT_ID, SHELL_AGENT_ID, decideAgentAvailability, decideAgentPicker } from '../session-card/agent-core.ts';
import { paintAgentChoiceMark } from '../session-card/agent-mark.ts';
import { suggestSessionName } from '../session-card/naming.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { needsAttention } from '../attention-core.ts';
import { STATES } from '#shared/states.ts';
import { elapsedText } from '#shared/display-text.ts';
import { decidePermissions } from '#shared/session-permissions.ts';
import { filterRows, lastPathSegment, orderRecentRows, orderWorkspaceRows, sessionNameBase } from '../add-session-core.ts';
import type { LiveSession, RecentRow, ScannedProject } from '../add-session-core.ts';
import { addSessionRefusalText, revealAddedSession } from '../session-actions.ts';
import { runStudioAddSession } from '../state/actions/add-session.ts';
import { clock } from '#shared/clock.ts';
import type { ApprovedPackLauncher } from '#shared/contracts/control/pack-messages.ts';
import { packsSnapshot, subscribePacks } from '../packs/packs-store.ts';
import { AgentModelCatalog } from '#shared/contracts/agent-models.ts';
import type { AgentSetup, ModelProvider, ModelSelection } from '#shared/contracts/agent-models.ts';
import type { StartPicks } from '#shared/contracts/start-picks.ts';
import { emptyStartPicks, rememberedSelectionFor } from '#shared/start-picks-core.ts';
import { canRunOnOpenRouter, configuredSetup, defaultSetup, effortOf, effortsOf, modelsOf, withEffortChoice } from '../arena/lineup-core.ts';
import { buildBackRow, buildChoiceRow, buildEffortRows, buildListLabel, buildModelRows, buildPickRow, firstModelPickOf, hasEfforts, modelLabelOf, setupAfterModelPick, setupAfterTypedPick } from './model-pick.ts';

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
  | { kind: 'github'; repo: GithubRepo }
  | { kind: 'workspace' }
  | { kind: 'folder' };

type AddSessionRequest = { message: Record<string, unknown>; requestType?: 'add-session' | 'pack-launch' | 'open-issue-session' };

type AddSessionSlot = 'agent' | 'account' | 'model' | 'project';
type QueriedSlot = 'project' | 'model';

const ISSUE_REPLY_TIMEOUT_MS = 90_000;
const ADD_SESSION_SLOTS: readonly AddSessionSlot[] = ['agent', 'account', 'model', 'project'];
const FIND_PLACEHOLDER_BY_SLOT: Readonly<Record<QueriedSlot, string>> = { project: 'Find a project, or #128 for an issue', model: 'Find or type a model' };
const LIST_LABEL_BY_SLOT: Readonly<Record<AddSessionSlot, string>> = { agent: 'Agents', account: 'Accounts', model: 'Models', project: 'Projects' };
const NO_TARGET: AddSessionTarget = { kind: 'none' };
const UNPROTECTED_ASKS_TEXT = 'Sane YOLO is not available here, so the agent asks before acting.';
const SIGN_IN_ON_START_TEXT = 'The session opens on its sign-in; follow it in the terminal once.';
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

type GithubRow = { name: string; repo: GithubRepo };

function repoFolderNameOf(repo: GithubRepo): string {
  return lastPathSegment(repo.fullName).toLowerCase();
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

type AddSessionPickerOptions = { onStarted: () => void; onCancel?: () => void; onStudioStarted?: ((mainId: string) => void) | null; studioRepoDir?: string | null };

export function mountAddSessionPicker(dialog: HTMLElement, { onStarted, onCancel, onStudioStarted = null, studioRepoDir = null }: AddSessionPickerOptions) {
  dialog.innerHTML = addSessionHTML;

  const pickEl = query(dialog, '#add-session-pick');
  const findInput = markAsNotCredential(queryTag(dialog, '#add-session-find', 'input'));
  const listEl = query(dialog, '#add-session-list');
  const repoRootsEl = query(dialog, '#add-session-repo-roots');
  const workspacePanel = query(dialog, '#add-session-workspace');
  const workspaceListEl = query(dialog, '#add-session-workspace-list');
  const workspaceFindInput = markAsNotCredential(queryTag(dialog, '#add-session-workspace-find', 'input'));
  const slotTitleEl = query(dialog, '#add-session-slot-title');
  const folderListEl = query(dialog, '#add-session-folder-list');
  const folderPanel = query(dialog, '#add-session-folder');
  const pathInput = markAsNotCredential(queryTag(dialog, '#add-session-path', 'input'));
  const unprotectedHintEl = query(dialog, '#add-session-unprotected');
  const signInHintEl = query(dialog, '#add-session-sign-in');
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
  const modelWord = createPressable('add-session-word');
  query(dialog, '#add-session-model-word-slot').replaceWith(modelWord);
  const accountWord = createPressable('add-session-word');
  query(dialog, '#add-session-account-word-slot').replaceWith(accountWord);
  const wordBySlot: Record<AddSessionSlot, HTMLButtonElement> = { agent: agentWord, account: accountWord, model: modelWord, project: repoWord };
  const startStatus = createActionStatus('dialog-hint');
  const btnConfirm = button({ variant: 'primary', label: 'Start session' });
  query(dialog, '#add-session-actions').append(startStatus.element, ...cancelButtons(onCancel), btnConfirm);

  let rememberedPicks: StartPicks = emptyStartPicks();
  let target: AddSessionTarget = NO_TARGET;
  let lastProjectTarget: AddSessionTarget = NO_TARGET;
  let scannedProjects: ScannedProject[] = [];
  let recentRows: RecentRow[] = [];
  let githubRepos: GithubRepo[] = [];
  let projectFolderNames: Set<string> | null = null;
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
  let agentModelCatalog = AgentModelCatalog.parse({ agents: [] });
  let operatorSetup: AgentSetup | null = null;
  let shownAccountValue = '';
  let effortStepModelId: string | null = null;
  let pickedRepoPaths: string[] = [];
  const queryBySlot: Record<QueriedSlot, string> = { project: '', model: '' };

  function requestControl(type: string, payload: Record<string, unknown>, timeoutMs = DEFAULT_REPLY_TIMEOUT_MS) {
    return sendControlRequest(type, payload, { timeoutMs });
  }

  const isShellChosen = () => selectedAgentId === SHELL_AGENT_ID;
  const agentLabelOf = (agentId: string) => agentOptions.find((agentOption) => agentOption.id === agentId)?.label ?? null;
  const pickAgentId = (rememberedAgentId: string | null) => {
    if (rememberedAgentId === null || rememberedAgentId === SHELL_AGENT_ID) return defaultAgentId;
    return agentOptions.some((agentOption) => agentOption.id === rememberedAgentId) ? rememberedAgentId : defaultAgentId;
  };

  const isSlotEmpty: Record<AddSessionSlot, () => boolean> = {
    agent: () => selectedAgentId === NO_AGENT_ID && (!isAgentListSettled || agentOptions.length > 0),
    account: () => false,
    model: () => false,
    project: () => target.kind === 'none',
  };
  const firstEmptySlot = () => ADD_SESSION_SLOTS.find((slot) => isSlotEmpty[slot]()) ?? null;

  function renderSentence() {
    const wordByKind: Record<AddSessionTarget['kind'], string> = {
      none: 'a project',
      project: target.kind === 'project' ? target.row.name : '',
      github: target.kind === 'github' ? lastPathSegment(target.repo.fullName) : '',
      workspace: 'several repos',
      folder: lastPathSegment(pathInput.value.trim()) || 'a folder',
    };
    repoWord.textContent = wordByKind[target.kind];
    repoWord.dataset.placeholder = String(target.kind === 'none');
    agentWordTextEl.textContent = agentLabelOf(selectedAgentId) ?? 'an agent';
    agentWord.dataset.placeholder = String(selectedAgentId === NO_AGENT_ID);
    agentWord.disabled = isAddPending;
    repoWord.disabled = isAddPending;
    renderModelWords();
    renderAccountWord();
    for (const slot of ADD_SESSION_SLOTS) wordBySlot[slot].setAttribute('aria-expanded', String(openSlot === slot));
    pickEl.hidden = openSlot === null;
    if (openSlot) pickEl.dataset.slot = openSlot === 'model' && effortStepModelId !== null ? 'effort' : openSlot;
    workspacePanel.hidden = openSlot !== null || target.kind !== 'workspace';
    folderPanel.hidden = openSlot !== null || target.kind !== 'folder';
  }

  function afterOperatorActs<Args extends unknown[]>(onPick: (...args: Args) => void) {
    return (...args: Args) => {
      markOperatorActed();
      onPick(...args);
    };
  }

  function buildSlotRow(key: string, name: string, isPicked: boolean, onPick: () => void) {
    return buildPickRow(key, name, isPicked, afterOperatorActs(onPick));
  }

  function buildAgentMark(agentId: string) {
    const markEl = el('span', 'agent-mark');
    markEl.setAttribute('aria-hidden', 'true');
    paintAgentChoiceMark(markEl, agentId, agentLabelOf(agentId));
    return markEl;
  }

  function keepingRowFocus(listElement: HTMLElement, render: () => void) {
    const focusedRowKey = document.activeElement instanceof HTMLElement && listElement.contains(document.activeElement) ? document.activeElement.dataset.key ?? null : null;
    render();
    if (focusedRowKey !== null) [...listElement.querySelectorAll<HTMLElement>('.add-session-row')].find((rowEl) => rowEl.dataset.key === focusedRowKey)?.focus();
  }

  function buildSlotChoiceRow(label: string, onPick: () => void) {
    return buildChoiceRow(label, afterOperatorActs(onPick));
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

  function buildGithubRow({ repo }: GithubRow) {
    const isPicked = target.kind === 'github' && target.repo.cloneUrl === repo.cloneUrl;
    const rowEl = buildSlotRow(repo.cloneUrl, repo.fullName, isPicked, () => {
      setGithubTarget(repo);
      advanceFromPick(true);
    });
    const job = cloneJobOf(repo.cloneUrl);
    const metaText = job === null ? (repo.isPrivate ? 'private' : '') : cloneJobStatusText(job);
    if (metaText !== '') rowEl.append(el('span', 'add-session-row-meta', metaText));
    return rowEl;
  }

  function githubRowsOffered(): GithubRow[] {
    const folderNamesOnHost = projectFolderNames;
    if (folderNamesOnHost === null) return [];
    return githubRepos
      .filter((repo) => !folderNamesOnHost.has(repoFolderNameOf(repo)))
      .map((repo) => ({ name: repo.fullName, repo }));
  }

  function visibleGithubRows(): GithubRow[] {
    return filterRows(githubRowsOffered(), queryBySlot.project);
  }

  function buildGithubGroup(): HTMLElement[] {
    const githubRows = visibleGithubRows();
    if (githubRows.length === 0) return [];
    return [buildListLabel('GitHub'), ...githubRows.map(buildGithubRow)];
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

  function issueNumberOf(query: string) {
    const digits = /^#?([0-9]+)$/.exec(query.trim())?.[1];
    const issueNumber = Number(digits);
    return digits !== undefined && Number.isSafeInteger(issueNumber) && issueNumber >= 1 ? issueNumber : null;
  }

  function issueProjects() {
    if (isShellChosen()) return [];
    const { picked, others } = orderWorkspaceRows(scannedProjects, target.kind === 'project' ? [target.row.path] : [], '');
    return [...picked, ...others];
  }

  function buildIssueRows(issueNumber: number) {
    return issueProjects().map((project) => buildSlotRow(`issue:${project.path}`, `Issue #${issueNumber} in ${project.name}`, false, () => startIssue(project, issueNumber)));
  }

  function buildProjectRows() {
    const issueNumber = issueNumberOf(queryBySlot.project);
    const issueRows = issueNumber === null ? [] : buildIssueRows(issueNumber);
    const rows: HTMLElement[] = [...issueRows, ...filterRows(recentRows, queryBySlot.project).map(buildProjectRow)];
    if (!isShellChosen() && scannedProjects.length >= 2) rows.push(buildSlotChoiceRow('Several repos', pickWorkspace));
    rows.push(buildSlotChoiceRow('Any folder', pickFolder));
    rows.push(...buildGithubGroup());
    return rows;
  }

  function renderModelWords() {
    const isPickable = isModelPickable(selectedAgentId);
    modelWord.disabled = isAddPending || !isPickable;
    modelWord.dataset.placeholder = String(!isPickable);
    if (!isPickable) {
      modelWord.textContent = selectedAgentId === NO_AGENT_ID ? 'a model' : 'no model';
      return;
    }
    const setup = shownSetup();
    const effort = effortsOf(agentModelCatalog, setup).length === 0 ? null : effortOf(setup);
    modelWord.textContent = effort === null ? modelLabelOf(agentModelCatalog, setup) : `${modelLabelOf(agentModelCatalog, setup)} ${effort}`;
  }

  function chooseSetup(next: AgentSetup) {
    errorEl.textContent = '';
    operatorSetup = next;
  }

  function finishModelPick() {
    effortStepModelId = null;
    queryBySlot.model = '';
    openSlotList('project');
  }

  function pickModel(provider: ModelProvider, modelId: string) {
    const picked = setupAfterModelPick(agentModelCatalog, shownSetup(), provider, modelId);
    chooseSetup(picked);
    if (!hasEfforts(agentModelCatalog, picked)) {
      finishModelPick();
      return;
    }
    effortStepModelId = modelId;
    renderList();
    focusOpenSlot();
  }

  function pickTypedModel(provider: ModelProvider, modelId: string) {
    chooseSetup(setupAfterTypedPick(agentModelCatalog, shownSetup(), provider, modelId));
    finishModelPick();
  }

  function pickEffort(effort: string | null) {
    chooseSetup(withEffortChoice(shownSetup(), effort));
    finishModelPick();
  }

  function buildSlotModelRows() {
    return buildModelRows({
      catalog: agentModelCatalog,
      agent: selectedAgentId,
      setup: shownSetup(),
      query: queryBySlot.model,
      onPickModel: afterOperatorActs(pickModel),
      onPickTypedModel: afterOperatorActs(pickTypedModel),
    });
  }

  function buildSlotEffortRows() {
    return buildEffortRows({ catalog: agentModelCatalog, setup: shownSetup(), onPickEffort: afterOperatorActs(pickEffort), onBack: backToModels });
  }

  function buildAccountRows() {
    return pickableAccounts().map((account) => {
      const accountValue = account.accountId ?? '';
      const rowEl = buildSlotRow(accountValue, account.label, accountValue === shownAccountValue, () => {
        operatorAccountChoice = { agentId: selectedAgentId, accountId: accountValue };
        showAccountPick();
        advance();
      });
      if (account.login.state === 'signed-out') rowEl.append(el('span', 'add-session-row-meta', 'signed out'));
      return rowEl;
    });
  }

  const rowsBySlot: Record<AddSessionSlot, () => HTMLElement[]> = {
    agent: () => agentOptions.map(buildAgentRow),
    account: buildAccountRows,
    model: () => (effortStepModelId === null ? buildSlotModelRows() : buildSlotEffortRows()),
    project: buildProjectRows,
  };

  function slotTitleOf(slot: AddSessionSlot) {
    if (slot === 'model' && effortStepModelId !== null) return `${modelLabelOf(agentModelCatalog, shownSetup())} effort`;
    return LIST_LABEL_BY_SLOT[slot];
  }

  function renderList() {
    renderSentence();
    const slot = openSlot;
    if (slot === null) return;
    slotTitleEl.textContent = slotTitleOf(slot);
    listEl.setAttribute('aria-label', LIST_LABEL_BY_SLOT[slot]);
    keepingRowFocus(listEl, () => listEl.replaceChildren(...rowsBySlot[slot]()));
  }

  function showFindFor(slot: AddSessionSlot | null) {
    if (slot !== 'project' && slot !== 'model') return;
    findInput.value = queryBySlot[slot];
    findInput.placeholder = FIND_PLACEHOLDER_BY_SLOT[slot];
    findInput.setAttribute('aria-label', FIND_PLACEHOLDER_BY_SLOT[slot]);
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
    if (openSlot === 'project' || (openSlot === 'model' && effortStepModelId === null)) {
      findInput.focus();
      return;
    }
    const pickedRow = listEl.querySelector<HTMLElement>('.add-session-row[aria-selected="true"]');
    (pickedRow ?? listEl.querySelector<HTMLElement>('.add-session-row:not(:disabled)'))?.focus();
  }

  function focusAfterLastSlot() {
    if (target.kind === 'workspace') {
      workspaceFindInput.focus();
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
    effortStepModelId = null;
    showFindFor(slot);
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
    return firstEmptySlot() === null && (target.kind === 'project' || target.kind === 'github') && selectedAgentId !== NO_AGENT_ID && hasSettingsLoaded && !isSpawnBlocked;
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

  function setGithubTarget(repo: GithubRepo) {
    target = { kind: 'github', repo };
    lastProjectTarget = target;
    errorEl.textContent = '';
  }

  function pickWorkspace() {
    target = { kind: 'workspace' };
    errorEl.textContent = '';
    renderWorkspaceRows();
    advance();
  }

  function pickFolder() {
    target = { kind: 'folder' };
    errorEl.textContent = '';
    advance();
  }

  function buildRepoRow(project: ScannedProject) {
    const isPicked = pickedRepoPaths.includes(project.path);
    const rowEl = buildSlotRow(project.path, project.name, isPicked, () => {
      pickedRepoPaths = isPicked ? pickedRepoPaths.filter((pickedPath) => pickedPath !== project.path) : [...pickedRepoPaths, project.path];
      errorEl.textContent = '';
      renderWorkspaceRows();
    });
    rowEl.prepend(el('span', 'add-session-row-tick'));
    return rowEl;
  }

  function workspaceGroup(label: string, projects: ScannedProject[]) {
    return [buildListLabel(label), ...projects.map(buildRepoRow)];
  }

  function renderWorkspaceRows() {
    const { picked, others } = orderWorkspaceRows(scannedProjects, pickedRepoPaths, workspaceFindInput.value);
    const repoRows = picked.length === 0 ? others.map(buildRepoRow) : [...workspaceGroup('Picked', picked), ...workspaceGroup('Repositories', others)];
    const rows = [buildBackRow('All projects', backToProjects), ...repoRows];
    keepingRowFocus(workspaceListEl, () => workspaceListEl.replaceChildren(...rows));
  }

  workspaceFindInput.addEventListener('input', () => {
    markOperatorActed();
    renderWorkspaceRows();
  });

  function returnToProjects() {
    target = lastProjectTarget;
    openSlot = 'project';
    renderList();
  }

  function rebuildRows() {
    recentRows = orderRecentRows(scannedProjects, rememberedPicks.agentByPath, liveSessionsByPath(), pickAgentId);
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
    if (agentId !== selectedAgentId) errorEl.textContent = '';
    selectedAgentId = agentId;
    paintAgentChoiceMark(agentMarkEl, agentId === NO_AGENT_ID ? null : agentId, agentLabelOf(agentId));
    applyAgentRules();
    renderList();
  }

  function applyAgentRules() {
    const isShell = isShellChosen();
    if (isShell && target.kind === 'workspace') returnToProjects();
    renderPermissionHint();
    showAccountPick();
  }

  function isModelPickable(agentId: string) {
    if (agentId === NO_AGENT_ID || agentId === SHELL_AGENT_ID) return false;
    return modelsOf(agentModelCatalog, agentId).length > 0 || canRunOnOpenRouter(agentId);
  }

  function rememberedSetup(): AgentSetup | null {
    const selection = rememberedSelectionFor(rememberedPicks, selectedAgentId, agentModelCatalog);
    return selection === null ? null : { ...selection, instructions: '' };
  }

  function chosenSetup(): AgentSetup | null {
    if (operatorSetup?.agent === selectedAgentId) return operatorSetup;
    return rememberedSetup();
  }

  function shownSetup() {
    return chosenSetup() ?? configuredSetup(agentModelCatalog, selectedAgentId) ?? defaultSetup(agentModelCatalog, selectedAgentId);
  }

  function setupForTheStart(): ModelSelection | null {
    const setup = isModelPickable(selectedAgentId) && operatorSetup?.agent === selectedAgentId ? operatorSetup : null;
    if (setup === null) return null;
    const { instructions: _instructions, ...selection } = setup;
    return selection;
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
    const chosenValue = operatorAccountChoice?.agentId === selectedAgentId ? operatorAccountChoice.accountId : null;
    const defaultValue = accounts.find((account) => account.isDefault)?.accountId ?? '';
    const isChosenListed = chosenValue !== null && accounts.some((account) => (account.accountId ?? '') === chosenValue);
    shownAccountValue = isChosenListed ? chosenValue : defaultValue;
    showSignInHint();
    renderList();
  }

  function isAccountPickable() {
    return pickableAccounts().length > 1;
  }

  function renderAccountWord() {
    const accounts = pickableAccounts();
    accountWord.disabled = isAddPending || !isAccountPickable();
    accountWord.dataset.placeholder = String(selectedAgentId === NO_AGENT_ID || isShellChosen());
    if (selectedAgentId === NO_AGENT_ID) {
      accountWord.textContent = 'an account';
      return;
    }
    if (isShellChosen()) {
      accountWord.textContent = 'no account';
      return;
    }
    accountWord.textContent = accounts.find((account) => (account.accountId ?? '') === shownAccountValue)?.label ?? 'default';
  }

  function accountForTheStart() {
    const accounts = agentAccountsOf(selectedAgentId).filter((account) => !account.isPending);
    if (!isAccountPickable()) return accounts.find((account) => account.isDefault) ?? null;
    return accounts.find((account) => (account.accountId ?? '') === shownAccountValue) ?? null;
  }

  function showSignInHint() {
    const account = accountForTheStart();
    const isSignedOut = account?.login.state === 'signed-out' && account.login.reason === null;
    signInHintEl.hidden = !isSignedOut;
    const signedOutText = account?.accountId === null ? `${agentLabelOf(selectedAgentId)} is not signed in yet.` : agentAccountSummary(account);
    signInHintEl.textContent = isSignedOut ? `${signedOutText} ${SIGN_IN_ON_START_TEXT}` : '';
  }
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
  const scanRow = el('div', 'add-session-scan flex items-center gap-2');
  scanRow.append(scanStatus.element, btnScanAgain);
  repoRootsEl.before(scanRow);

  function showScanFailure(reason: string) {
    scanStatus.show('error', `The project scan failed: ${reason}`);
    btnScanAgain.hidden = false;
    btnScanAgain.disabled = false;
  }

  function showRepoRootsAdder(message: ServerMessage) {
    const isScan = message.type === 'repo-roots-scanned';
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
        projectFolderNames = new Set(scannedProjects.map((project) => lastPathSegment(project.path).toLowerCase()));
        rebuildRows();
        if (scannedProjects.length === 0) showRepoRootsAdder(message);
      })
      .catch((reason: unknown) => { showScanFailure(requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS)); });
  }

  function isPickVisible() {
    if (target.kind === 'project') {
      const pickedPath = target.row.path;
      return filterRows(recentRows, queryBySlot.project).some((row) => row.path === pickedPath);
    }
    if (target.kind === 'github') {
      const pickedUrl = target.repo.cloneUrl;
      return visibleGithubRows().some((row) => row.repo.cloneUrl === pickedUrl);
    }
    return false;
  }

  function pickFirstVisible() {
    const firstProjectRow = filterRows(recentRows, queryBySlot.project)[0];
    if (firstProjectRow) {
      setProjectTarget(firstProjectRow);
      return;
    }
    const firstGithubRow = visibleGithubRows()[0];
    if (firstGithubRow) setGithubTarget(firstGithubRow.repo);
  }

  findInput.addEventListener('input', () => {
    markOperatorActed();
    if (openSlot === 'model') queryBySlot.model = findInput.value;
    if (openSlot === 'project') {
      queryBySlot.project = findInput.value;
      if (!isPickVisible()) pickFirstVisible();
    }
    renderList();
  });

  function loadGithubRepos() {
    return requestGithubRepos().then((listing) => {
      if (listing.kind !== 'listed') return;
      githubRepos = listing.repos;
      renderList();
    });
  }

  const stopWatchingCloneJobs = onCloneJobsChanged(() => {
    if (!dialog.isConnected) {
      stopWatchingCloneJobs();
      return;
    }
    if (openSlot === 'project') renderList();
  });

  function backToModels() {
    effortStepModelId = null;
    renderList();
    focusOpenSlot();
  }

  function backToProjects() {
    returnToProjects();
    focusOpenSlot();
  }

  folderListEl.replaceChildren(buildBackRow('All projects', backToProjects));
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

  function applySettings(settings: unknown) {
    isSaneYoloInstalled = isSaneYoloAvailable(settings);
    isSaneYoloSettingOn = settingFlag(settings, 'saneYolo') !== false;
    skipsPermissionsByDefault = settingFlag(settings, 'skipPermissionsByDefault') === true;
    const catalog = AgentModelCatalog.safeParse(typeof settings === 'object' && settings !== null ? Reflect.get(settings, 'agentModels') : undefined);
    if (catalog.success) agentModelCatalog = catalog.data;
    renderList();
    hasSettingsLoaded = true;
    clearSettingsWarning();
    renderPermissionHint();
  }

  function applyLiveSettings() {
    settingsLoadCount += 1;
    applySettings(settingsPayloadSnapshot());
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
        applySettings(message.settings);
      }))
      .catch(whileLatestSettings((reason: unknown) => {
        failSettingsClosed(`Could not load your settings (${requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS)}), so the session follows your machine permission setting.`);
      }));
  }

  function permissionFields() {
    if (!hasSettingsLoaded) return { dangerouslySkipPermissions: false };
    return decidePermissions({ isSaneYoloInstalled, isSaneYoloSettingOn, isShell: isShellChosen() }).fields;
  }

  function refusesUnpickedAgent() {
    if (selectedAgentId !== NO_AGENT_ID || agentOptions.length === 0) return false;
    errorEl.textContent = 'Pick an agent.';
    return true;
  }

  function buildRequest(): AddSessionRequest | null {
    if (refusesUnpickedAgent()) return null;
    const isShell = isShellChosen();
    const shared: Record<string, unknown> = { ...permissionFields() };
    if (selectedAgentId !== NO_AGENT_ID) shared.agent = selectedAgentId;
    if (isAccountPickable()) shared.accountId = shownAccountValue === '' ? null : shownAccountValue;
    const setup = setupForTheStart();
    if (setup !== null) shared.setup = setup;
    if (target.kind === 'project') {
      return { message: { ...shared, name: suggestSessionName(sessionNameBase(target.row.name)), path: target.row.path } };
    }
    if (target.kind === 'github') {
      const clonedPath = cloneJobOf(target.repo.cloneUrl)?.path ?? null;
      if (clonedPath === null) {
        errorEl.textContent = 'The clone has no folder yet.';
        return null;
      }
      return { message: { ...shared, name: suggestSessionName(sessionNameBase(lastPathSegment(target.repo.fullName))), path: clonedPath } };
    }
    if (target.kind === 'workspace') {
      const repos = orderWorkspaceRows(scannedProjects, pickedRepoPaths, '').picked.map((project) => project.path);
      if (repos.length < 2) {
        errorEl.textContent = 'Pick at least two repositories.';
        return null;
      }
      return { message: { ...shared, name: suggestSessionName(sessionNameBase(lastPathSegment(repos[0]))), path: repos[0], repos } };
    }
    if (target.kind === 'folder') {
      const folderPath = pathInput.value.trim();
      if (!folderPath && !isShell) {
        errorEl.textContent = 'Enter a folder path.';
        return null;
      }
      return { message: { ...shared, name: suggestSessionName(sessionNameBase(folderPath ? lastPathSegment(folderPath) : SHELL_AGENT_ID)), path: folderPath } };
    }
    errorEl.textContent = 'Pick a project.';
    return null;
  }

  function submit() {
    if (isSpawnBlocked || isAddPending) return;
    errorEl.textContent = '';
    if (target.kind === 'github' && cloneJobOf(target.repo.cloneUrl)?.state !== 'done') {
      void cloneThenSubmit(target.repo);
      return;
    }
    const request = buildRequest();
    if (request) requestAddSession(request);
  }

  function startIssue(project: ScannedProject, issueNumber: number) {
    if (isSpawnBlocked || isAddPending) return;
    errorEl.textContent = '';
    const row = recentRows.find((recentRow) => recentRow.path === project.path);
    if (row) setProjectTarget(row);
    queryBySlot.project = '';
    showFindFor('project');
    renderList();
    const request = buildRequest();
    if (!request) return;
    const { name: _name, ...sessionFields } = request.message;
    requestAddSession({ message: { ...sessionFields, path: project.path, issueNumber }, requestType: 'open-issue-session' });
  }

  function holdForWork(statusText: string) {
    isAddPending = true;
    btnConfirm.disabled = true;
    lockPicking(true);
    startStatus.show('busy', statusText);
  }

  function releaseHold() {
    isAddPending = false;
    startStatus.clear();
    btnConfirm.disabled = isSpawnBlocked;
    lockPicking(false);
  }

  async function cloneThenSubmit(repo: GithubRepo) {
    if (refusesUnpickedAgent()) return;
    holdForWork(`Cloning ${repo.fullName}`);
    const failure = isCloneJobUnsettled(cloneJobOf(repo.cloneUrl)) ? null : await requestRepositoryClones([repo.cloneUrl]);
    if (failure !== null) {
      releaseHold();
      errorEl.textContent = failure;
      return;
    }
    const stopWatchingClone = onCloneJobsChanged(followClone);
    followClone();

    function followClone() {
      if (!dialog.isConnected) {
        stopWatchingClone();
        return;
      }
      const job = cloneJobOf(repo.cloneUrl);
      if (isCloneJobUnsettled(job)) {
        startStatus.show('busy', `Cloning ${repo.fullName}: ${cloneJobStatusText(job)}`);
        return;
      }
      stopWatchingClone();
      releaseHold();
      if (job?.state === 'done') {
        submit();
        return;
      }
      errorEl.textContent = `${repo.fullName} was not cloned: ${cloneJobStatusText(job)}`;
    }
  }

  function lockPicking(isLocked: boolean) {
    const pickingRegions = [pickEl, workspacePanel, folderPanel, launchersEl];
    if (isLocked && pickingRegions.some((region) => region.contains(document.activeElement))) dialog.focus();
    for (const region of pickingRegions) region.inert = isLocked;
    renderSentence();
  }

  function buildLauncher(launcher: ApprovedPackLauncher) {
    const launcherEl = el('div', 'add-session-launcher');
    const launchButton = button({ variant: 'secondary', label: launcher.label });
    launchButton.disabled = launcher.disabledReason !== null;
    launchButton.addEventListener('click', () => {
      if (isSpawnBlocked || isAddPending) return;
      errorEl.textContent = '';
      requestAddSession({ message: { pack: launcher.pack, launcherId: launcher.id }, requestType: 'pack-launch' });
    });
    launcherEl.append(launchButton, el('span', 'dialog-hint', launcher.disabledReason ?? `${launcher.agent} in ${launcher.project}`));
    return launcherEl;
  }

  function renderLaunchers() {
    const launchers = packsSnapshot()?.launchers ?? [];
    launchersEl.hidden = launchers.length === 0;
    launchersEl.replaceChildren(...launchers.map(buildLauncher));
  }

  function requestAddSession({ message, requestType = 'add-session' }: AddSessionRequest) {
    holdForWork('Starting the session');
    const showRefusal = (text: string) => { errorEl.textContent = text; };
    const replyTimeoutMs = requestType === 'open-issue-session' ? ISSUE_REPLY_TIMEOUT_MS : DEFAULT_REPLY_TIMEOUT_MS;
    const isStudioRequest = onStudioStarted !== null && requestType === 'add-session';
    if (isStudioRequest) {
      void runStudioAddSession({
        ...(message as { name: string; path: string }),
        studio: true,
        timeoutMs: replyTimeoutMs,
      })
        .then((outcome) => {
          if (outcome.ok && outcome.reply.type === 'add-session-result' && outcome.reply.ok) {
            onStarted();
            if (outcome.reply.sessionId) onStudioStarted(outcome.reply.sessionId);
            return;
          }
          if (!outcome.ok) {
            showRefusal(outcome.error.message);
            return;
          }
          showRefusal(addSessionRefusalText(outcome.reply));
        })
        .finally(() => {
          releaseHold();
          if (dialog.isConnected && isFocusAdrift()) focusOpenSlot();
        });
      return;
    }
    requestControl(requestType, message, replyTimeoutMs)
      .then((reply) => {
        if (reply.type === 'add-session-result' && reply.ok) {
          onStarted();
          revealAddedSession(reply.sessionId);
          return;
        }
        showRefusal(addSessionRefusalText(reply));
      })
      .catch((reason) => { showRefusal(`The session was not added: ${requestFailureText(reason, replyTimeoutMs)}`); })
      .finally(() => {
        releaseHold();
        if (dialog.isConnected && isFocusAdrift()) focusOpenSlot();
      });
  }

  btnConfirm.addEventListener('click', submit);
  pathInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
  findInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (openSlot === 'model') {
      event.preventDefault();
      const firstPick = firstModelPickOf(agentModelCatalog, selectedAgentId, queryBySlot.model);
      if (firstPick?.kind === 'listed') pickModel(firstPick.provider, firstPick.modelId);
      if (firstPick?.kind === 'typed') pickTypedModel(firstPick.provider, firstPick.modelId);
      return;
    }
    const issueNumber = issueNumberOf(queryBySlot.project);
    const firstIssueProject = issueNumber === null ? undefined : issueProjects()[0];
    if (issueNumber !== null && firstIssueProject) {
      event.preventDefault();
      startIssue(firstIssueProject, issueNumber);
      return;
    }
    if (target.kind !== 'project' && target.kind !== 'github') return;
    event.preventDefault();
    advanceFromPick(isPickVisible());
  });

  const stopWatchingPacks = subscribePacks(() => {
    if (!dialog.isConnected) {
      stopWatchingPacks();
      return;
    }
    renderLaunchers();
  });
  renderLaunchers();
  if (studioRepoDir !== null) {
    target = { kind: 'folder' };
    pathInput.value = studioRepoDir;
  }
  advance();
  refresh();

  function loadStartPicks() {
    return requestControl('list-start-picks', {})
      .then((message: ServerMessage) => {
        if (message.type !== 'start-picks') return;
        rememberedPicks = message.picks;
        rebuildRows();
      })
      .catch(() => {});
  }

  function refresh() {
    void loadStartPicks();
    void fillProjectList();
    void loadGithubRepos();
    void loadAgents();
    void loadSettings();
  }

  return { refresh, applyLiveSettings };
}
