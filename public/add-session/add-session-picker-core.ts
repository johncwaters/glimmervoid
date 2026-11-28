import type { AgentAccountStatus } from '#shared/contracts/agent-accounts.ts';
import { AgentModelCatalog } from '#shared/contracts/agent-models.ts';
import type { AgentSetup, ModelProvider, ModelSelection } from '#shared/contracts/agent-models.ts';
import type { ServerMessage, ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { RepositoryCloneJob } from '#shared/contracts/control/settings-messages.ts';
import type { StartPicks } from '#shared/contracts/start-picks.ts';
import { elapsedText } from '#shared/display-text.ts';
import { decidePermissions } from '#shared/session-permissions.ts';
import { emptyStartPicks, rememberedSelectionFor } from '#shared/start-picks-core.ts';
import { filterRows, lastPathSegment, orderRecentRows, sessionNameBase } from '../add-session-core.ts';
import type { LiveSession, RecentRow, ScannedProject } from '../add-session-core.ts';
import { canRunOnOpenRouter, configuredSetup, defaultSetup, effortOf, effortsOf, modelsOf, withEffortChoice } from '../arena/lineup-core.ts';
import {
  effortListRowsOf,
  firstModelPickOf,
  hasModelEfforts,
  modelLabelOf,
  modelListRowsOf,
  setupAfterModelPick,
  setupAfterTypedPick,
} from '../chat/model-picker-core.ts';
import type { ModelPickerRow } from '../chat/model-picker-core.ts';
import { DEFAULT_AGENT_ID, SHELL_AGENT_ID, decideAgentAvailability, decideAgentPicker } from '../session-card/agent-core.ts';

export type GithubRepo = ServerMessageOf<'github-repos-listed'>['repos'][number];
export type RepoRootSuggestion = NonNullable<ServerMessageOf<'repo-roots-scanned'>['suggestions']>[number];
export type AddSessionSlot = 'agent' | 'account' | 'model' | 'project';
type QueriedSlot = 'project' | 'model';
type OperatorTouch = 'untouched' | 'acted' | 'reopened';

type AddSessionTarget =
  | { readonly kind: 'none' }
  | { readonly kind: 'project'; readonly row: RecentRow }
  | { readonly kind: 'github'; readonly repo: GithubRepo }
  | { readonly kind: 'workspace' }
  | { readonly kind: 'folder' };

type AddSessionWorkState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy'; readonly statusText: string };

type AddSessionScanState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string }
  | { readonly kind: 'empty'; readonly suggestions: readonly RepoRootSuggestion[] };

interface PermissionSettings {
  readonly isSaneYoloInstalled: boolean;
  readonly isSaneYoloSettingOn: boolean;
  readonly skipsPermissionsByDefault: boolean;
}

interface AddSessionPickerState {
  readonly isStudio: boolean;
  readonly rememberedPicks: StartPicks;
  readonly target: AddSessionTarget;
  readonly lastProjectTarget: AddSessionTarget;
  readonly scannedProjects: readonly ScannedProject[];
  readonly recentRows: readonly RecentRow[];
  readonly githubRepos: readonly GithubRepo[];
  readonly projectFolderNames: readonly string[] | null;
  readonly agentOptions: readonly { readonly id: string; readonly label: string }[];
  readonly defaultAgentId: string;
  readonly selectedAgentId: string;
  readonly settingsState: 'loading' | 'loaded' | 'failed';
  readonly settingsLoadCount: number;
  readonly agentsLoadCount: number;
  readonly agentWarning: { readonly text: string; readonly id: string | null } | null;
  readonly settingsWarning: string | null;
  readonly permissions: PermissionSettings;
  readonly spawnGate: 'open' | 'blocked';
  readonly workState: AddSessionWorkState;
  readonly agentListState: 'loading' | 'settled';
  readonly openSlot: AddSessionSlot | null;
  readonly operatorTouch: OperatorTouch;
  readonly operatorAccountChoice: { readonly agentId: string; readonly accountId: string } | null;
  readonly agentModelCatalog: AgentModelCatalog;
  readonly operatorSetup: AgentSetup | null;
  readonly shownAccountValue: string;
  readonly effortStepModelId: string | null;
  readonly pickedRepoPaths: readonly string[];
  readonly queryBySlot: { readonly project: string; readonly model: string };
  readonly workspaceQuery: string;
  readonly folderPath: string;
  readonly errorText: string;
  readonly scanState: AddSessionScanState;
}

type AddSessionFocusTarget = 'none' | 'dialog' | 'find' | 'selected-row' | 'workspace-find' | 'path' | 'confirm';

export interface AddSessionTransition {
  readonly state: AddSessionPickerState;
  readonly syncFindValue: string | null;
  readonly postAction: 'none' | 'focus' | 'submit';
}

interface AddSessionDisplay {
  readonly agentWordText: string;
  readonly agentWordPlaceholder: 'true' | 'false';
  readonly agentWordDisabled: boolean;
  readonly agentMarkId: string | null;
  readonly agentMarkLabel: string | null;
  readonly accountWordText: string;
  readonly accountWordPlaceholder: 'true' | 'false';
  readonly accountWordDisabled: boolean;
  readonly modelWordText: string;
  readonly modelWordPlaceholder: 'true' | 'false';
  readonly modelWordDisabled: boolean;
  readonly repoWordText: string;
  readonly repoWordPlaceholder: 'true' | 'false';
  readonly repoWordDisabled: boolean;
  readonly expandedBySlot: Readonly<Record<AddSessionSlot, 'true' | 'false'>>;
  readonly pickHidden: boolean;
  readonly pickDataSlot: AddSessionSlot | 'effort' | undefined;
  readonly slotTitle: string;
  readonly listAriaLabel: string;
  readonly findPlaceholder: string;
  readonly workspaceHidden: boolean;
  readonly folderHidden: boolean;
  readonly isPickingLocked: boolean;
  readonly confirmDisabled: boolean;
  readonly unprotectedHintHidden: boolean;
  readonly unprotectedHintText: string;
  readonly signInHintHidden: boolean;
  readonly signInHintText: string;
  readonly scanAgainHidden: boolean;
  readonly scanAgainDisabled: boolean;
  readonly repoRootsHidden: boolean;
  readonly scanStatusTone: 'busy' | 'error' | null;
  readonly scanStatusText: string;
  readonly scanStatusClassName: string;
  readonly scanStatusHidden: boolean;
  readonly startStatusTone: 'busy' | null;
  readonly startStatusText: string;
  readonly startStatusClassName: string;
  readonly startStatusHidden: boolean;
}

interface LiveCountBadge {
  readonly count: number;
  readonly label: string;
  readonly tone: 'running' | 'waiting';
}

export type ProjectSlotRow =
  | { readonly kind: 'issue'; readonly key: string; readonly name: string; readonly project: ScannedProject; readonly issueNumber: number }
  | { readonly kind: 'project'; readonly key: string; readonly name: string; readonly isPicked: boolean; readonly row: RecentRow; readonly counts: readonly LiveCountBadge[]; readonly ageText: string | null }
  | { readonly kind: 'choice'; readonly key: string; readonly label: string; readonly choice: 'workspace' | 'folder' }
  | { readonly kind: 'group-label'; readonly key: string; readonly text: string }
  | { readonly kind: 'github'; readonly key: string; readonly name: string; readonly isPicked: boolean; readonly repo: GithubRepo; readonly metaText: string };

export interface AgentSlotRow {
  readonly key: string;
  readonly id: string;
  readonly label: string;
  readonly isPicked: boolean;
}

export interface AccountSlotRow {
  readonly key: string;
  readonly value: string;
  readonly label: string;
  readonly isPicked: boolean;
  readonly metaText: string | null;
}

type WorkspacePanelRow =
  | { readonly kind: 'back'; readonly key: string; readonly label: string }
  | { readonly kind: 'group-label'; readonly key: string; readonly text: string }
  | { readonly kind: 'repo'; readonly key: string; readonly name: string; readonly path: string; readonly isPicked: boolean };

export type AddSessionRequestPayload =
  | { readonly requestType: 'add-session'; readonly message: Record<string, unknown>; readonly timeoutMs: number }
  | { readonly requestType: 'pack-launch'; readonly message: { readonly pack: string; readonly launcherId: string }; readonly timeoutMs: number }
  | { readonly requestType: 'open-issue-session'; readonly message: Record<string, unknown>; readonly timeoutMs: number };

type StartSubmissionDecision =
  | { readonly kind: 'noop' }
  | { readonly kind: 'error'; readonly state: AddSessionPickerState }
  | { readonly kind: 'clone-then-submit'; readonly state: AddSessionPickerState; readonly repo: GithubRepo }
  | { readonly kind: 'request'; readonly state: AddSessionPickerState; readonly request: AddSessionRequestPayload };

type FindKeydownDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'pick-listed-model'; readonly provider: ModelProvider; readonly modelId: string }
  | { readonly kind: 'pick-typed-model'; readonly provider: ModelProvider; readonly modelId: string }
  | { readonly kind: 'start-issue'; readonly project: ScannedProject; readonly issueNumber: number }
  | { readonly kind: 'advance-project'; readonly isTargetVisible: boolean };

type AddSessionActionOutcomeDecision =
  | { readonly kind: 'started'; readonly sessionId: string | null }
  | { readonly kind: 'refused'; readonly errorText: string };

const NO_AGENT_ID = '';
export const ISSUE_REPLY_TIMEOUT_MS = 90_000;
const ADD_SESSION_SLOTS: readonly AddSessionSlot[] = ['agent', 'account', 'model', 'project'];
const FIND_PLACEHOLDER_BY_SLOT: Readonly<Record<QueriedSlot, string>> = {
  project: 'Find a project, or #128 for an issue',
  model: 'Find or type a model',
};
const LIST_LABEL_BY_SLOT: Readonly<Record<AddSessionSlot, string>> = {
  agent: 'Agents',
  account: 'Accounts',
  model: 'Models',
  project: 'Projects',
};
const NO_TARGET: AddSessionTarget = { kind: 'none' };
const UNPROTECTED_ASKS_TEXT = 'Sane YOLO is not available here, so the agent asks before acting.';
const SIGN_IN_ON_START_TEXT = 'The session opens on its sign-in; follow it in the terminal once.';
const UNPROTECTED_SKIPS_TEXT = 'Sane YOLO is not available here, so this session skips permission prompts unprotected.';

function isSaneYoloAvailable(settings: unknown): boolean {
  if (typeof settings !== 'object' || settings === null) return false;
  return 'saneYoloAvailable' in settings && settings.saneYoloAvailable === true;
}

function settingFlag(settings: unknown, key: string): boolean | null {
  if (typeof settings !== 'object' || settings === null || !(key in settings)) return null;
  const value: unknown = Reflect.get(settings, key);
  return typeof value === 'boolean' ? value : null;
}

function formatRelativeAge(receivedAt: number, nowMs: number): string {
  const elapsedMs = nowMs - receivedAt;
  if (!Number.isFinite(elapsedMs)) return 'just now';
  return elapsedText(elapsedMs, { rounding: 'floor', wording: 'abbreviated', suffix: ' ago', justNowBelowSeconds: 60 });
}

function scannedProjectsOf(message: ServerMessage): ScannedProject[] {
  if (message.type !== 'repo-roots-scanned') return [];
  return message.directories.flatMap((directory) => directory.projects.map(({ name, path, lastActivityMs }) => ({ name, path, lastActivityMs })));
}

function repoFolderNameOf(repo: GithubRepo): string {
  return lastPathSegment(repo.fullName).toLowerCase();
}

function isShellChosen(state: AddSessionPickerState): boolean {
  return state.selectedAgentId === SHELL_AGENT_ID;
}

function agentLabelOf(state: AddSessionPickerState, agentId: string): string | null {
  return state.agentOptions.find((agentOption) => agentOption.id === agentId)?.label ?? null;
}

function pickAgentIdForState(state: AddSessionPickerState, rememberedAgentId: string | null): string {
  if (rememberedAgentId === null || rememberedAgentId === SHELL_AGENT_ID) return state.defaultAgentId;
  return state.agentOptions.some((agentOption) => agentOption.id === rememberedAgentId) ? rememberedAgentId : state.defaultAgentId;
}

function isSlotEmpty(state: AddSessionPickerState, slot: AddSessionSlot): boolean {
  if (slot === 'agent') {
    return state.selectedAgentId === NO_AGENT_ID && (state.agentListState !== 'settled' || state.agentOptions.length > 0);
  }
  if (slot === 'project') return state.target.kind === 'none';
  return false;
}

function firstEmptySlotOf(state: AddSessionPickerState): AddSessionSlot | null {
  return ADD_SESSION_SLOTS.find((slot) => isSlotEmpty(state, slot)) ?? null;
}

function isModelPickable(catalog: AgentModelCatalog, agentId: string): boolean {
  if (agentId === NO_AGENT_ID || agentId === SHELL_AGENT_ID) return false;
  return modelsOf(catalog, agentId).length > 0 || canRunOnOpenRouter(agentId);
}

function shownSetupOf(state: AddSessionPickerState): AgentSetup {
  if (state.operatorSetup?.agent === state.selectedAgentId) return state.operatorSetup;
  const remembered = rememberedSelectionFor(state.rememberedPicks, state.selectedAgentId, state.agentModelCatalog);
  if (remembered !== null) return { ...remembered, instructions: '' };
  return configuredSetup(state.agentModelCatalog, state.selectedAgentId) ?? defaultSetup(state.agentModelCatalog, state.selectedAgentId);
}

function setupForStartOf(state: AddSessionPickerState): ModelSelection | null {
  const setup = isModelPickable(state.agentModelCatalog, state.selectedAgentId) && state.operatorSetup?.agent === state.selectedAgentId
    ? state.operatorSetup
    : null;
  if (setup === null) return null;
  const { instructions: _instructions, ...selection } = setup;
  return selection;
}

function pickableAccountsOf(accounts: readonly AgentAccountStatus[]): AgentAccountStatus[] {
  const nonPending = accounts.filter((account) => !account.isPending);
  return nonPending.some((account) => account.accountId !== null) ? nonPending : [];
}

function resolveShownAccountValue(state: AddSessionPickerState, accounts: readonly AgentAccountStatus[]): string {
  const pickable = pickableAccountsOf(accounts);
  const chosenValue = state.operatorAccountChoice?.agentId === state.selectedAgentId ? state.operatorAccountChoice.accountId : null;
  const defaultValue = pickable.find((account) => account.isDefault)?.accountId ?? '';
  const isChosenListed = chosenValue !== null && pickable.some((account) => (account.accountId ?? '') === chosenValue);
  return isChosenListed ? chosenValue : defaultValue;
}

function accountForStartOf(state: AddSessionPickerState, accounts: readonly AgentAccountStatus[]): AgentAccountStatus | null {
  const nonPending = accounts.filter((account) => !account.isPending);
  if (pickableAccountsOf(accounts).length <= 1) return nonPending.find((account) => account.isDefault) ?? null;
  return nonPending.find((account) => (account.accountId ?? '') === state.shownAccountValue) ?? null;
}

function markOperatorActed(state: AddSessionPickerState): AddSessionPickerState {
  if (state.operatorTouch !== 'untouched') return state;
  return { ...state, operatorTouch: 'acted' };
}

function syncFindValueForSlot(state: AddSessionPickerState, slot: AddSessionSlot | null): string | null {
  if (slot !== 'project' && slot !== 'model') return null;
  return state.queryBySlot[slot];
}

function openSlotTransition(state: AddSessionPickerState, slot: AddSessionSlot | null): AddSessionTransition {
  const nextState: AddSessionPickerState = { ...state, openSlot: slot, effortStepModelId: null };
  return {
    state: nextState,
    syncFindValue: syncFindValueForSlot(nextState, slot),
    postAction: 'focus',
  };
}

function advanceTransition(state: AddSessionPickerState): AddSessionTransition {
  const nextTouch: OperatorTouch = state.operatorTouch === 'reopened' ? 'acted' : state.operatorTouch;
  const nextState: AddSessionPickerState = { ...state, operatorTouch: nextTouch };
  return openSlotTransition(nextState, firstEmptySlotOf(nextState));
}

function canStartOnPick(state: AddSessionPickerState): boolean {
  return (
    firstEmptySlotOf(state) === null &&
    (state.target.kind === 'project' || state.target.kind === 'github') &&
    state.selectedAgentId !== NO_AGENT_ID &&
    state.settingsState === 'loaded' &&
    state.spawnGate === 'open'
  );
}

function advanceFromPickTransition(state: AddSessionPickerState, isTargetChosenByOperator: boolean): AddSessionTransition {
  if (!isTargetChosenByOperator || !canStartOnPick(state)) return advanceTransition(state);
  const nextTouch: OperatorTouch = state.operatorTouch === 'reopened' ? 'acted' : state.operatorTouch;
  return {
    state: { ...state, operatorTouch: nextTouch },
    syncFindValue: null,
    postAction: 'submit',
  };
}

function githubRowsOfferedOf(state: AddSessionPickerState): { name: string; repo: GithubRepo }[] {
  if (state.projectFolderNames === null) return [];
  const folderNameSet = new Set(state.projectFolderNames);
  return state.githubRepos
    .filter((repo) => !folderNameSet.has(repoFolderNameOf(repo)))
    .map((repo) => ({ name: repo.fullName, repo }));
}

function visibleGithubRowsOf(state: AddSessionPickerState): { name: string; repo: GithubRepo }[] {
  return filterRows(githubRowsOfferedOf(state), state.queryBySlot.project);
}

function isProjectPickVisible(state: AddSessionPickerState): boolean {
  if (state.target.kind === 'project') {
    const pickedPath = state.target.row.path;
    return filterRows(state.recentRows, state.queryBySlot.project).some((row) => row.path === pickedPath);
  }
  if (state.target.kind === 'github') {
    const pickedUrl = state.target.repo.cloneUrl;
    return visibleGithubRowsOf(state).some((row) => row.repo.cloneUrl === pickedUrl);
  }
  return false;
}

function partitionWorkspaceProjects(
  projects: readonly ScannedProject[],
  pickedPaths: readonly string[],
  query: string,
): { picked: ScannedProject[]; others: ScannedProject[] } {
  const projectByPath = new Map<string, ScannedProject>();
  for (const project of projects) {
    if (!projectByPath.has(project.path)) projectByPath.set(project.path, project);
  }
  const pickedSet = new Set<string>();
  const picked: ScannedProject[] = [];
  for (const pickedPath of pickedPaths) {
    const match = projectByPath.get(pickedPath);
    if (!match || pickedSet.has(pickedPath)) continue;
    pickedSet.add(pickedPath);
    picked.push(match);
  }
  const unpicked = projects.filter((project) => !pickedSet.has(project.path));
  return { picked, others: filterRows(unpicked, query) };
}

function issueNumberOf(query: string): number | null {
  const digits = /^#?([0-9]+)$/.exec(query.trim())?.[1];
  const issueNumber = Number(digits);
  return digits !== undefined && Number.isSafeInteger(issueNumber) && issueNumber >= 1 ? issueNumber : null;
}

function issueProjectsOf(state: AddSessionPickerState): ScannedProject[] {
  if (isShellChosen(state)) return [];
  const preferredPath = state.target.kind === 'project' ? state.target.row.path : null;
  if (preferredPath === null) return [...state.scannedProjects];
  const preferred: ScannedProject[] = [];
  const rest: ScannedProject[] = [];
  for (const project of state.scannedProjects) {
    if (project.path === preferredPath) {
      preferred.push(project);
      continue;
    }
    rest.push(project);
  }
  return [...preferred, ...rest];
}

function rebuildRecentRows(state: AddSessionPickerState, liveSessions: readonly LiveSession[]): AddSessionPickerState {
  const recentRows = orderRecentRows(
    state.scannedProjects,
    state.rememberedPicks.agentByPath,
    liveSessions,
    (rememberedAgentId) => pickAgentIdForState(state, rememberedAgentId),
  );
  if (state.target.kind !== 'project') return { ...state, recentRows };
  const pickedPath = state.target.row.path;
  const refreshedRow = recentRows.find((row) => row.path === pickedPath) ?? null;
  if (!refreshedRow) return { ...state, recentRows };
  const refreshedTarget: AddSessionTarget = { kind: 'project', row: refreshedRow };
  return { ...state, recentRows, target: refreshedTarget, lastProjectTarget: refreshedTarget, errorText: '' };
}

function settleOpenSlot(
  state: AddSessionPickerState,
  isFocusInsidePick: boolean,
  isFocusAdrift: boolean,
): AddSessionTransition {
  if (state.operatorTouch !== 'untouched' && isFocusInsidePick) {
    return { state, syncFindValue: null, postAction: 'none' };
  }
  const nextEmpty = firstEmptySlotOf(state);
  const isOpenSlotDone = state.openSlot === null
    ? nextEmpty !== null
    : state.operatorTouch !== 'reopened' && !isSlotEmpty(state, state.openSlot);
  const isUntouchedReorder = state.operatorTouch === 'untouched' && state.openSlot !== nextEmpty;
  if (isOpenSlotDone || isUntouchedReorder) return advanceTransition(state);
  return {
    state,
    syncFindValue: null,
    postAction: state.operatorTouch !== 'reopened' && isFocusAdrift ? 'focus' : 'none',
  };
}

export function createInitialAddSessionState(options: {
  isStudio: boolean;
  studioRepoDir: string | null;
}): AddSessionPickerState {
  const base: AddSessionPickerState = {
    isStudio: options.isStudio,
    rememberedPicks: emptyStartPicks(),
    target: options.studioRepoDir !== null ? { kind: 'folder' } : NO_TARGET,
    lastProjectTarget: NO_TARGET,
    scannedProjects: [],
    recentRows: [],
    githubRepos: [],
    projectFolderNames: null,
    agentOptions: [],
    defaultAgentId: DEFAULT_AGENT_ID,
    selectedAgentId: NO_AGENT_ID,
    settingsState: 'loading',
    settingsLoadCount: 0,
    agentsLoadCount: 0,
    agentWarning: null,
    settingsWarning: null,
    permissions: { isSaneYoloInstalled: false, isSaneYoloSettingOn: true, skipsPermissionsByDefault: false },
    spawnGate: 'open',
    workState: { kind: 'idle' },
    agentListState: 'loading',
    openSlot: null,
    operatorTouch: 'untouched',
    operatorAccountChoice: null,
    agentModelCatalog: AgentModelCatalog.parse({ agents: [] }),
    operatorSetup: null,
    shownAccountValue: '',
    effortStepModelId: null,
    pickedRepoPaths: [],
    queryBySlot: { project: '', model: '' },
    workspaceQuery: '',
    folderPath: options.studioRepoDir ?? '',
    errorText: '',
    scanState: { kind: 'idle' },
  };
  return advanceTransition(base).state;
}

export function addSessionDisplayOf(
  state: AddSessionPickerState,
  accounts: readonly AgentAccountStatus[],
  formatAccountSummary: (account: AgentAccountStatus | null) => string,
): AddSessionDisplay {
  const isBusy = state.workState.kind === 'busy';
  const isShell = isShellChosen(state);
  const agentLabel = agentLabelOf(state, state.selectedAgentId);
  const pickableAccounts = pickableAccountsOf(accounts);
  const accountPickable = pickableAccounts.length > 1;
  const modelPickable = isModelPickable(state.agentModelCatalog, state.selectedAgentId);
  const setup = shownSetupOf(state);
  const modelEffort = effortsOf(state.agentModelCatalog, setup).length === 0 ? null : effortOf(setup);
  const modelText = !modelPickable
    ? (state.selectedAgentId === NO_AGENT_ID ? 'a model' : 'no model')
    : (modelEffort === null ? modelLabelOf(state.agentModelCatalog, setup) : `${modelLabelOf(state.agentModelCatalog, setup)} ${modelEffort}`);
  const accountText = state.selectedAgentId === NO_AGENT_ID
    ? 'an account'
    : isShell
      ? 'no account'
      : (pickableAccounts.find((account) => (account.accountId ?? '') === state.shownAccountValue)?.label ?? 'default');
  const repoWordByKind: Record<AddSessionTarget['kind'], string> = {
    none: 'a project',
    project: state.target.kind === 'project' ? state.target.row.name : '',
    github: state.target.kind === 'github' ? lastPathSegment(state.target.repo.fullName) : '',
    workspace: 'several repos',
    folder: lastPathSegment(state.folderPath.trim()) || 'a folder',
  };
  const permissionChoice = decidePermissions({
    isSaneYoloInstalled: state.permissions.isSaneYoloInstalled,
    isSaneYoloSettingOn: state.permissions.isSaneYoloSettingOn,
    isShell,
  });
  const startAccount = accountForStartOf(state, accounts);
  const isSignedOut = startAccount?.login.state === 'signed-out' && startAccount.login.reason === null;
  const signedOutPrefix = startAccount?.accountId === null
    ? `${agentLabel} is not signed in yet.`
    : formatAccountSummary(startAccount);
  const slotTitle = state.openSlot === null
    ? ''
    : state.openSlot === 'model' && state.effortStepModelId !== null
      ? `${modelLabelOf(state.agentModelCatalog, setup)} effort`
      : LIST_LABEL_BY_SLOT[state.openSlot];
  const findSlot: QueriedSlot = state.openSlot === 'model' ? 'model' : 'project';

  return {
    agentWordText: agentLabel ?? 'an agent',
    agentWordPlaceholder: state.selectedAgentId === NO_AGENT_ID ? 'true' : 'false',
    agentWordDisabled: isBusy,
    agentMarkId: state.selectedAgentId === NO_AGENT_ID ? null : state.selectedAgentId,
    agentMarkLabel: agentLabel,
    accountWordText: accountText,
    accountWordPlaceholder: state.selectedAgentId === NO_AGENT_ID || isShell ? 'true' : 'false',
    accountWordDisabled: isBusy || !accountPickable,
    modelWordText: modelText,
    modelWordPlaceholder: modelPickable ? 'false' : 'true',
    modelWordDisabled: isBusy || !modelPickable,
    repoWordText: repoWordByKind[state.target.kind],
    repoWordPlaceholder: state.target.kind === 'none' ? 'true' : 'false',
    repoWordDisabled: isBusy,
    expandedBySlot: {
      agent: state.openSlot === 'agent' ? 'true' : 'false',
      account: state.openSlot === 'account' ? 'true' : 'false',
      model: state.openSlot === 'model' ? 'true' : 'false',
      project: state.openSlot === 'project' ? 'true' : 'false',
    },
    pickHidden: state.openSlot === null,
    pickDataSlot: state.openSlot === null ? undefined : (state.openSlot === 'model' && state.effortStepModelId !== null ? 'effort' : state.openSlot),
    slotTitle,
    listAriaLabel: state.openSlot === null ? LIST_LABEL_BY_SLOT.project : LIST_LABEL_BY_SLOT[state.openSlot],
    findPlaceholder: FIND_PLACEHOLDER_BY_SLOT[findSlot],
    workspaceHidden: state.openSlot !== null || state.target.kind !== 'workspace',
    folderHidden: state.openSlot !== null || state.target.kind !== 'folder',
    isPickingLocked: isBusy,
    confirmDisabled: state.spawnGate === 'blocked' || isBusy,
    unprotectedHintHidden: state.settingsState !== 'loaded' || !permissionChoice.isUnprotectedHintShown,
    unprotectedHintText: state.permissions.skipsPermissionsByDefault ? UNPROTECTED_SKIPS_TEXT : UNPROTECTED_ASKS_TEXT,
    signInHintHidden: !isSignedOut,
    signInHintText: isSignedOut ? `${signedOutPrefix} ${SIGN_IN_ON_START_TEXT}` : '',
    scanAgainHidden: state.scanState.kind !== 'error',
    scanAgainDisabled: state.scanState.kind === 'busy',
    repoRootsHidden: state.scanState.kind !== 'empty',
    scanStatusTone: state.scanState.kind === 'busy' || state.scanState.kind === 'error' ? state.scanState.kind : null,
    scanStatusText: state.scanState.kind === 'busy' || state.scanState.kind === 'error' ? state.scanState.text : '',
    scanStatusClassName: state.scanState.kind === 'busy'
      ? 'dialog-hint text-meta text-text-muted'
      : state.scanState.kind === 'error'
        ? 'dialog-hint text-meta text-state-failed'
        : 'dialog-hint',
    scanStatusHidden: state.scanState.kind !== 'busy' && state.scanState.kind !== 'error',
    startStatusTone: state.workState.kind === 'busy' ? 'busy' : null,
    startStatusText: state.workState.kind === 'busy' ? state.workState.statusText : '',
    startStatusClassName: state.workState.kind === 'busy' ? 'dialog-hint text-meta text-text-muted' : 'dialog-hint',
    startStatusHidden: state.workState.kind !== 'busy',
  };
}

export function agentSlotRowsOf(state: AddSessionPickerState): AgentSlotRow[] {
  return state.agentOptions.map((option) => ({
    key: option.id,
    id: option.id,
    label: option.label,
    isPicked: option.id === state.selectedAgentId,
  }));
}

export function accountSlotRowsOf(state: AddSessionPickerState, accounts: readonly AgentAccountStatus[]): AccountSlotRow[] {
  return pickableAccountsOf(accounts).map((account) => {
    const value = account.accountId ?? '';
    return {
      key: value,
      value,
      label: account.label,
      isPicked: value === state.shownAccountValue,
      metaText: account.login.state === 'signed-out' ? 'signed out' : null,
    };
  });
}

export function modelSlotRowsOf(state: AddSessionPickerState): ModelPickerRow[] {
  const setup = shownSetupOf(state);
  if (state.effortStepModelId === null) {
    return modelListRowsOf(state.agentModelCatalog, state.selectedAgentId, setup, state.queryBySlot.model);
  }
  return effortListRowsOf(state.agentModelCatalog, setup);
}

export function projectSlotRowsOf(
  state: AddSessionPickerState,
  readCloneJob: (cloneUrl: string) => RepositoryCloneJob | null,
  formatCloneStatus: (job: RepositoryCloneJob | null) => string,
  nowMs: number,
): ProjectSlotRow[] {
  const rows: ProjectSlotRow[] = [];
  const issueNumber = issueNumberOf(state.queryBySlot.project);
  if (issueNumber !== null) {
    for (const project of issueProjectsOf(state)) {
      rows.push({
        kind: 'issue',
        key: `issue:${project.path}`,
        name: `Issue #${issueNumber} in ${project.name}`,
        project,
        issueNumber,
      });
    }
  }
  for (const row of filterRows(state.recentRows, state.queryBySlot.project)) {
    const counts: LiveCountBadge[] = [];
    if (row.runningCount > 0) counts.push({ count: row.runningCount, label: 'running', tone: 'running' });
    if (row.waitingCount > 0) counts.push({ count: row.waitingCount, label: 'waiting', tone: 'waiting' });
    const ageText = counts.length === 0 && row.lastActivityMs !== null ? formatRelativeAge(row.lastActivityMs, nowMs) : null;
    rows.push({
      kind: 'project',
      key: row.path,
      name: row.name,
      isPicked: state.target.kind === 'project' && state.target.row.path === row.path,
      row,
      counts,
      ageText,
    });
  }
  if (!isShellChosen(state) && state.scannedProjects.length >= 2) {
    rows.push({ kind: 'choice', key: 'Several repos', label: 'Several repos', choice: 'workspace' });
  }
  rows.push({ kind: 'choice', key: 'Any folder', label: 'Any folder', choice: 'folder' });
  const visibleGithub = visibleGithubRowsOf(state);
  if (visibleGithub.length > 0) {
    rows.push({ kind: 'group-label', key: 'group:GitHub', text: 'GitHub' });
    for (const { repo } of visibleGithub) {
      const job = readCloneJob(repo.cloneUrl);
      const metaText = job === null ? (repo.isPrivate ? 'private' : '') : formatCloneStatus(job);
      rows.push({
        kind: 'github',
        key: repo.cloneUrl,
        name: repo.fullName,
        isPicked: state.target.kind === 'github' && state.target.repo.cloneUrl === repo.cloneUrl,
        repo,
        metaText,
      });
    }
  }
  return rows;
}

export function workspacePanelRowsOf(state: AddSessionPickerState): WorkspacePanelRow[] {
  const { picked, others } = partitionWorkspaceProjects(state.scannedProjects, state.pickedRepoPaths, state.workspaceQuery);
  const rows: WorkspacePanelRow[] = [{ kind: 'back', key: 'back:All projects', label: 'All projects' }];
  if (picked.length === 0) {
    for (const project of others) {
      rows.push({ kind: 'repo', key: project.path, name: project.name, path: project.path, isPicked: false });
    }
    return rows;
  }
  rows.push({ kind: 'group-label', key: 'group:Picked', text: 'Picked' });
  for (const project of picked) {
    rows.push({ kind: 'repo', key: project.path, name: project.name, path: project.path, isPicked: true });
  }
  rows.push({ kind: 'group-label', key: 'group:Repositories', text: 'Repositories' });
  for (const project of others) {
    rows.push({ kind: 'repo', key: project.path, name: project.name, path: project.path, isPicked: false });
  }
  return rows;
}

export function applyReopenSlot(state: AddSessionPickerState, slot: AddSessionSlot): AddSessionTransition {
  return openSlotTransition({ ...state, operatorTouch: 'reopened' }, slot);
}

export function applyPickProject(state: AddSessionPickerState, row: RecentRow): AddSessionTransition {
  const target: AddSessionTarget = { kind: 'project', row };
  const nextState: AddSessionPickerState = { ...markOperatorActed(state), target, lastProjectTarget: target, errorText: '' };
  return advanceFromPickTransition(nextState, true);
}

export function applyAdvanceFromPick(state: AddSessionPickerState, isTargetChosenByOperator: boolean): AddSessionTransition {
  return advanceFromPickTransition(state, isTargetChosenByOperator);
}

export function applyPickGithub(state: AddSessionPickerState, repo: GithubRepo): AddSessionTransition {
  const target: AddSessionTarget = { kind: 'github', repo };
  const nextState: AddSessionPickerState = { ...markOperatorActed(state), target, lastProjectTarget: target, errorText: '' };
  return advanceFromPickTransition(nextState, true);
}

export function applyPickWorkspace(state: AddSessionPickerState): AddSessionTransition {
  return advanceTransition({ ...markOperatorActed(state), target: { kind: 'workspace' }, errorText: '' });
}

export function applyPickFolder(state: AddSessionPickerState): AddSessionTransition {
  return advanceTransition({ ...markOperatorActed(state), target: { kind: 'folder' }, errorText: '' });
}

export function applyPickAgent(
  state: AddSessionPickerState,
  agentId: string,
  accountsForAgent: readonly AgentAccountStatus[],
): AddSessionTransition {
  const targetBeforePick = state.target;
  const acted = markOperatorActed(state);
  const switchedToShellFromWorkspace = agentId === SHELL_AGENT_ID && acted.target.kind === 'workspace';
  const nextTarget = switchedToShellFromWorkspace ? acted.lastProjectTarget : acted.target;
  const nextOpenSlot = switchedToShellFromWorkspace ? 'project' : acted.openSlot;
  const withAgent: AddSessionPickerState = {
    ...acted,
    selectedAgentId: agentId,
    errorText: agentId !== acted.selectedAgentId ? '' : acted.errorText,
    target: nextTarget,
    openSlot: nextOpenSlot,
  };
  const nextState: AddSessionPickerState = {
    ...withAgent,
    shownAccountValue: resolveShownAccountValue(withAgent, accountsForAgent),
  };
  return advanceFromPickTransition(nextState, nextState.target === targetBeforePick);
}

export function applyPickAccount(
  state: AddSessionPickerState,
  accountValue: string,
  accountsForAgent: readonly AgentAccountStatus[],
): AddSessionTransition {
  const withChoice: AddSessionPickerState = {
    ...markOperatorActed(state),
    operatorAccountChoice: { agentId: state.selectedAgentId, accountId: accountValue },
  };
  const nextState: AddSessionPickerState = {
    ...withChoice,
    shownAccountValue: resolveShownAccountValue(withChoice, accountsForAgent),
  };
  return advanceTransition(nextState);
}

export function applyAccountsChanged(
  state: AddSessionPickerState,
  accountsForAgent: readonly AgentAccountStatus[],
): AddSessionPickerState {
  const nextValue = resolveShownAccountValue(state, accountsForAgent);
  if (nextValue === state.shownAccountValue) return state;
  return { ...state, shownAccountValue: nextValue };
}

function finishModelPickTransition(state: AddSessionPickerState): AddSessionTransition {
  const cleared: AddSessionPickerState = {
    ...state,
    effortStepModelId: null,
    queryBySlot: { ...state.queryBySlot, model: '' },
  };
  return openSlotTransition(cleared, 'project');
}

export function applyPickListedModel(
  state: AddSessionPickerState,
  provider: ModelProvider,
  modelId: string,
): AddSessionTransition {
  const acted = markOperatorActed(state);
  const picked = setupAfterModelPick(acted.agentModelCatalog, shownSetupOf(acted), provider, modelId);
  const withSetup: AddSessionPickerState = { ...acted, operatorSetup: picked, errorText: '' };
  if (!hasModelEfforts(withSetup.agentModelCatalog, picked)) {
    return finishModelPickTransition(withSetup);
  }
  return {
    state: { ...withSetup, effortStepModelId: modelId },
    syncFindValue: null,
    postAction: 'focus',
  };
}

export function applyPickTypedModel(
  state: AddSessionPickerState,
  provider: ModelProvider,
  modelId: string,
): AddSessionTransition {
  const acted = markOperatorActed(state);
  const picked = setupAfterTypedPick(acted.agentModelCatalog, shownSetupOf(acted), provider, modelId);
  return finishModelPickTransition({ ...acted, operatorSetup: picked, errorText: '' });
}

export function applyPickEffort(state: AddSessionPickerState, effort: string | null): AddSessionTransition {
  const acted = markOperatorActed(state);
  const picked = withEffortChoice(shownSetupOf(acted), effort);
  return finishModelPickTransition({ ...acted, operatorSetup: picked, errorText: '' });
}

export function applyBackToModels(state: AddSessionPickerState): AddSessionTransition {
  return {
    state: { ...state, effortStepModelId: null },
    syncFindValue: null,
    postAction: 'focus',
  };
}

export function applyBackToProjects(state: AddSessionPickerState): AddSessionTransition {
  const nextState: AddSessionPickerState = { ...state, target: state.lastProjectTarget, openSlot: 'project' };
  return {
    state: nextState,
    syncFindValue: syncFindValueForSlot(nextState, 'project'),
    postAction: 'focus',
  };
}

export function applyToggleWorkspaceRepo(state: AddSessionPickerState, repoPath: string): AddSessionPickerState {
  const acted = markOperatorActed(state);
  const isPicked = acted.pickedRepoPaths.includes(repoPath);
  const pickedRepoPaths = isPicked
    ? acted.pickedRepoPaths.filter((candidate) => candidate !== repoPath)
    : [...acted.pickedRepoPaths, repoPath];
  return { ...acted, pickedRepoPaths, errorText: '' };
}

export function applyFindInput(state: AddSessionPickerState, value: string): AddSessionPickerState {
  const acted = markOperatorActed(state);
  if (acted.openSlot === 'model') {
    return { ...acted, queryBySlot: { ...acted.queryBySlot, model: value } };
  }
  if (acted.openSlot !== 'project') return acted;
  const withQuery: AddSessionPickerState = { ...acted, queryBySlot: { ...acted.queryBySlot, project: value } };
  if (isProjectPickVisible(withQuery)) return withQuery;
  const firstProject = filterRows(withQuery.recentRows, value)[0];
  if (firstProject) {
    const target: AddSessionTarget = { kind: 'project', row: firstProject };
    return { ...withQuery, target, lastProjectTarget: target, errorText: '' };
  }
  const firstGithub = visibleGithubRowsOf(withQuery)[0];
  if (firstGithub) {
    const target: AddSessionTarget = { kind: 'github', repo: firstGithub.repo };
    return { ...withQuery, target, lastProjectTarget: target, errorText: '' };
  }
  return withQuery;
}

export function applyWorkspaceFindInput(state: AddSessionPickerState, value: string): AddSessionPickerState {
  return { ...markOperatorActed(state), workspaceQuery: value };
}

export function applyFolderPathInput(state: AddSessionPickerState, value: string): AddSessionPickerState {
  if (state.folderPath === value) return state;
  return { ...state, folderPath: value };
}

export function decideFindKeydown(
  state: AddSessionPickerState,
  key: string,
  isComposing: boolean,
): FindKeydownDecision {
  if (isComposing || key === 'Process' || key !== 'Enter') return { kind: 'none' };
  if (state.openSlot === 'model') {
    const firstPick = firstModelPickOf(state.agentModelCatalog, state.selectedAgentId, state.queryBySlot.model);
    if (firstPick.kind === 'pick-listed') {
      return { kind: 'pick-listed-model', provider: firstPick.provider, modelId: firstPick.modelId };
    }
    if (firstPick.kind === 'pick-typed') {
      return { kind: 'pick-typed-model', provider: firstPick.provider, modelId: firstPick.modelId };
    }
    return { kind: 'none' };
  }
  const issueNumber = issueNumberOf(state.queryBySlot.project);
  const firstIssueProject = issueNumber === null ? undefined : issueProjectsOf(state)[0];
  if (issueNumber !== null && firstIssueProject) {
    return { kind: 'start-issue', project: firstIssueProject, issueNumber };
  }
  if (state.target.kind !== 'project' && state.target.kind !== 'github') return { kind: 'none' };
  return { kind: 'advance-project', isTargetVisible: isProjectPickVisible(state) };
}

export function applyFindKeydown(
  state: AddSessionPickerState,
  key: string,
  isComposing: boolean,
): { readonly kind: 'none' } | { readonly kind: 'transition'; readonly transition: AddSessionTransition } | { readonly kind: 'start-issue'; readonly project: ScannedProject; readonly issueNumber: number } {
  const decision = decideFindKeydown(state, key, isComposing);
  if (decision.kind === 'none') return { kind: 'none' };
  if (decision.kind === 'pick-listed-model') {
    return { kind: 'transition', transition: applyPickListedModel(state, decision.provider, decision.modelId) };
  }
  if (decision.kind === 'pick-typed-model') {
    return { kind: 'transition', transition: applyPickTypedModel(state, decision.provider, decision.modelId) };
  }
  if (decision.kind === 'start-issue') return decision;
  return { kind: 'transition', transition: applyAdvanceFromPick(state, decision.isTargetVisible) };
}

export function decidePathKeydown(key: string, isComposing: boolean): 'submit' | 'none' {
  if (isComposing || key === 'Process' || key !== 'Enter') return 'none';
  return 'submit';
}

export function beginRepoScan(state: AddSessionPickerState): AddSessionPickerState {
  return { ...state, scanState: { kind: 'busy', text: 'Scanning your repository roots' } };
}

export function applyRepoScanReply(
  state: AddSessionPickerState,
  message: ServerMessage,
  liveSessions: readonly LiveSession[],
): AddSessionPickerState {
  if (message.type === 'repo-roots-scanned' && message.error) {
    return { ...state, scanState: { kind: 'error', text: `The project scan failed: ${message.error}` } };
  }
  const scannedProjects = scannedProjectsOf(message);
  const projectFolderNames = [...new Set(scannedProjects.map((project) => lastPathSegment(project.path).toLowerCase()))];
  const suggestions = message.type === 'repo-roots-scanned' ? (message.suggestions ?? []) : [];
  const scanState: AddSessionScanState = scannedProjects.length === 0
    ? { kind: 'empty', suggestions }
    : { kind: 'idle' };
  return rebuildRecentRows({ ...state, scannedProjects, projectFolderNames, scanState }, liveSessions);
}

export function applyRepoScanError(state: AddSessionPickerState, reasonText: string): AddSessionPickerState {
  return { ...state, scanState: { kind: 'error', text: `The project scan failed: ${reasonText}` } };
}

export function applyStartPicksReply(
  state: AddSessionPickerState,
  message: ServerMessage,
  liveSessions: readonly LiveSession[],
): AddSessionPickerState {
  if (message.type !== 'start-picks') return state;
  return rebuildRecentRows({ ...state, rememberedPicks: message.picks }, liveSessions);
}

export function applyGithubReposReply(state: AddSessionPickerState, repos: readonly GithubRepo[]): AddSessionPickerState {
  return { ...state, githubRepos: repos };
}

export function beginAgentsLoad(state: AddSessionPickerState): { state: AddSessionPickerState; loadNumber: number } {
  const loadNumber = state.agentsLoadCount + 1;
  return { state: { ...state, agentsLoadCount: loadNumber }, loadNumber };
}

export function applyAgentsListed(
  state: AddSessionPickerState,
  loadNumber: number,
  message: ServerMessage,
  liveSessions: readonly LiveSession[],
  readAccounts: (agentId: string) => readonly AgentAccountStatus[],
  isFocusInsidePick: boolean,
  isFocusAdrift: boolean,
): AddSessionTransition {
  if (loadNumber !== state.agentsLoadCount) {
    return { state, syncFindValue: null, postAction: 'none' };
  }
  const replyError = message.type !== 'agents-listed'
    ? (message.type === 'error' ? message.message : `unexpected reply ${message.type}`)
    : (typeof Reflect.get(message, 'error') === 'string' && String(Reflect.get(message, 'error')).length > 0
      ? String(Reflect.get(message, 'error'))
      : null);
  if (replyError !== null) {
    return applyAgentsLoadError(state, loadNumber, replyError, isFocusInsidePick, isFocusAdrift);
  }
  const availability = decideAgentAvailability(message);
  const decision = decideAgentPicker(message.agents);
  const nextAgentId = decision.options.some((option) => option.id === state.selectedAgentId)
    ? state.selectedAgentId
    : NO_AGENT_ID;
  const switchedToShellFromWorkspace = nextAgentId === SHELL_AGENT_ID && state.target.kind === 'workspace';
  const withAgents: AddSessionPickerState = {
    ...state,
    spawnGate: availability.canSpawn ? 'open' : 'blocked',
    agentWarning: availability.canSpawn ? null : { text: availability.guidance, id: 'add-session-agent-guidance' },
    agentOptions: decision.options,
    defaultAgentId: decision.selectedId,
    agentListState: 'settled',
    selectedAgentId: nextAgentId,
    errorText: nextAgentId !== state.selectedAgentId ? '' : state.errorText,
    target: switchedToShellFromWorkspace ? state.lastProjectTarget : state.target,
    openSlot: switchedToShellFromWorkspace ? 'project' : state.openSlot,
  };
  const withAccount: AddSessionPickerState = {
    ...withAgents,
    shownAccountValue: resolveShownAccountValue(withAgents, readAccounts(nextAgentId)),
  };
  const withRows = rebuildRecentRows(withAccount, liveSessions);
  return settleOpenSlot(withRows, isFocusInsidePick, isFocusAdrift);
}

export function applyAgentsLoadError(
  state: AddSessionPickerState,
  loadNumber: number,
  reasonText: string,
  isFocusInsidePick: boolean,
  isFocusAdrift: boolean,
): AddSessionTransition {
  if (loadNumber !== state.agentsLoadCount || state.agentListState === 'settled') {
    return { state, syncFindValue: null, postAction: 'none' };
  }
  const nextState: AddSessionPickerState = {
    ...state,
    agentListState: 'settled',
    agentWarning: {
      text: `Could not load the agent list (${reasonText}), so the session uses the default agent.`,
      id: null,
    },
  };
  return settleOpenSlot(nextState, isFocusInsidePick, isFocusAdrift);
}

export function beginSettingsLoad(state: AddSessionPickerState): { state: AddSessionPickerState; loadNumber: number } {
  const loadNumber = state.settingsLoadCount + 1;
  return { state: { ...state, settingsState: 'loading', settingsLoadCount: loadNumber }, loadNumber };
}

function applySettingsObject(state: AddSessionPickerState, settings: unknown): AddSessionPickerState {
  const parsedCatalog = AgentModelCatalog.safeParse(
    typeof settings === 'object' && settings !== null ? Reflect.get(settings, 'agentModels') : undefined,
  );
  return {
    ...state,
    permissions: {
      isSaneYoloInstalled: isSaneYoloAvailable(settings),
      isSaneYoloSettingOn: settingFlag(settings, 'saneYolo') !== false,
      skipsPermissionsByDefault: settingFlag(settings, 'skipPermissionsByDefault') === true,
    },
    agentModelCatalog: parsedCatalog.success ? parsedCatalog.data : state.agentModelCatalog,
    settingsState: 'loaded',
    settingsWarning: null,
  };
}

export function applySettingsMessage(
  state: AddSessionPickerState,
  loadNumber: number,
  message: ServerMessage,
): AddSessionPickerState {
  if (loadNumber !== state.settingsLoadCount) return state;
  if (message.type === 'settings-error' || message.type === 'error') {
    return {
      ...state,
      settingsState: 'failed',
      settingsWarning: `Could not load your settings (${message.message}), so the session follows your machine permission setting.`,
    };
  }
  if (message.type !== 'settings') return state;
  return applySettingsObject(state, message.settings);
}

export function applySettingsLoadError(
  state: AddSessionPickerState,
  loadNumber: number,
  reasonText: string,
): AddSessionPickerState {
  if (loadNumber !== state.settingsLoadCount) return state;
  return {
    ...state,
    settingsState: 'failed',
    settingsWarning: `Could not load your settings (${reasonText}), so the session follows your machine permission setting.`,
  };
}

export function applyLiveSettingsPayload(state: AddSessionPickerState, payload: unknown): AddSessionPickerState {
  return applySettingsObject({ ...state, settingsLoadCount: state.settingsLoadCount + 1 }, payload);
}

export function applyWorkBusy(state: AddSessionPickerState, statusText: string): AddSessionPickerState {
  return { ...state, workState: { kind: 'busy', statusText } };
}

export function applyWorkIdle(state: AddSessionPickerState, errorText?: string): AddSessionPickerState {
  if (errorText === undefined) return { ...state, workState: { kind: 'idle' } };
  return { ...state, workState: { kind: 'idle' }, errorText };
}

function buildSharedStartFields(
  state: AddSessionPickerState,
  accounts: readonly AgentAccountStatus[],
): Record<string, unknown> {
  const permissionFields = state.settingsState !== 'loaded'
    ? { dangerouslySkipPermissions: false }
    : decidePermissions({
      isSaneYoloInstalled: state.permissions.isSaneYoloInstalled,
      isSaneYoloSettingOn: state.permissions.isSaneYoloSettingOn,
      isShell: isShellChosen(state),
    }).fields;
  const shared: Record<string, unknown> = { ...permissionFields };
  if (state.selectedAgentId !== NO_AGENT_ID) shared.agent = state.selectedAgentId;
  if (pickableAccountsOf(accounts).length > 1) {
    shared.accountId = state.shownAccountValue === '' ? null : state.shownAccountValue;
  }
  const setup = setupForStartOf(state);
  if (setup !== null) shared.setup = setup;
  return shared;
}

export function buildStartSubmission(
  state: AddSessionPickerState,
  deps: {
    accounts: readonly AgentAccountStatus[];
    readCloneJob: (cloneUrl: string) => RepositoryCloneJob | null;
    suggestName: (base: string) => string;
    defaultTimeoutMs: number;
  },
): StartSubmissionDecision {
  if (state.spawnGate === 'blocked' || state.workState.kind === 'busy') return { kind: 'noop' };
  const cleared: AddSessionPickerState = { ...state, errorText: '' };
  if (cleared.selectedAgentId === NO_AGENT_ID && cleared.agentOptions.length > 0) {
    return { kind: 'error', state: { ...cleared, errorText: 'Pick an agent.' } };
  }
  if (cleared.target.kind === 'github' && deps.readCloneJob(cleared.target.repo.cloneUrl)?.state !== 'done') {
    return { kind: 'clone-then-submit', state: cleared, repo: cleared.target.repo };
  }
  const shared = buildSharedStartFields(cleared, deps.accounts);
  if (cleared.target.kind === 'project') {
    return {
      kind: 'request',
      state: cleared,
      request: {
        requestType: 'add-session',
        message: { ...shared, name: deps.suggestName(sessionNameBase(cleared.target.row.name)), path: cleared.target.row.path },
        timeoutMs: deps.defaultTimeoutMs,
      },
    };
  }
  if (cleared.target.kind === 'github') {
    const clonedPath = deps.readCloneJob(cleared.target.repo.cloneUrl)?.path ?? null;
    if (clonedPath === null) {
      return { kind: 'error', state: { ...cleared, errorText: 'The clone has no folder yet.' } };
    }
    return {
      kind: 'request',
      state: cleared,
      request: {
        requestType: 'add-session',
        message: { ...shared, name: deps.suggestName(sessionNameBase(lastPathSegment(cleared.target.repo.fullName))), path: clonedPath },
        timeoutMs: deps.defaultTimeoutMs,
      },
    };
  }
  if (cleared.target.kind === 'workspace') {
    const repos = partitionWorkspaceProjects(cleared.scannedProjects, cleared.pickedRepoPaths, '').picked.map((project) => project.path);
    if (repos.length < 2) {
      return { kind: 'error', state: { ...cleared, errorText: 'Pick at least two repositories.' } };
    }
    return {
      kind: 'request',
      state: cleared,
      request: {
        requestType: 'add-session',
        message: { ...shared, name: deps.suggestName(sessionNameBase(lastPathSegment(repos[0]))), path: repos[0], repos },
        timeoutMs: deps.defaultTimeoutMs,
      },
    };
  }
  if (cleared.target.kind === 'folder') {
    const folderPath = cleared.folderPath.trim();
    if (!folderPath && !isShellChosen(cleared)) {
      return { kind: 'error', state: { ...cleared, errorText: 'Enter a folder path.' } };
    }
    return {
      kind: 'request',
      state: cleared,
      request: {
        requestType: 'add-session',
        message: { ...shared, name: deps.suggestName(sessionNameBase(folderPath ? lastPathSegment(folderPath) : SHELL_AGENT_ID)), path: folderPath },
        timeoutMs: deps.defaultTimeoutMs,
      },
    };
  }
  return { kind: 'error', state: { ...cleared, errorText: 'Pick a project.' } };
}

export function buildIssueStartSubmission(
  state: AddSessionPickerState,
  project: ScannedProject,
  issueNumber: number,
  deps: { accounts: readonly AgentAccountStatus[] },
): StartSubmissionDecision {
  if (state.spawnGate === 'blocked' || state.workState.kind === 'busy') return { kind: 'noop' };
  const matchingRow = state.recentRows.find((recentRow) => recentRow.path === project.path) ?? null;
  const target: AddSessionTarget = matchingRow ? { kind: 'project', row: matchingRow } : state.target;
  const nextState: AddSessionPickerState = {
    ...state,
    errorText: '',
    target,
    lastProjectTarget: matchingRow ? target : state.lastProjectTarget,
    queryBySlot: { ...state.queryBySlot, project: '' },
  };
  if (nextState.selectedAgentId === NO_AGENT_ID && nextState.agentOptions.length > 0) {
    return { kind: 'error', state: { ...nextState, errorText: 'Pick an agent.' } };
  }
  const shared = buildSharedStartFields(nextState, deps.accounts);
  return {
    kind: 'request',
    state: nextState,
    request: {
      requestType: 'open-issue-session',
      message: { ...shared, path: project.path, issueNumber },
      timeoutMs: ISSUE_REPLY_TIMEOUT_MS,
    },
  };
}

export function buildPackLaunchSubmission(
  state: AddSessionPickerState,
  pack: string,
  launcherId: string,
  defaultTimeoutMs: number,
): StartSubmissionDecision {
  if (state.spawnGate === 'blocked' || state.workState.kind === 'busy') return { kind: 'noop' };
  return {
    kind: 'request',
    state: { ...state, errorText: '' },
    request: {
      requestType: 'pack-launch',
      message: { pack, launcherId },
      timeoutMs: defaultTimeoutMs,
    },
  };
}

export function decideFocusTarget(state: AddSessionPickerState, isPhoneLayout: boolean): AddSessionFocusTarget {
  if (state.openSlot === null) {
    if (state.target.kind === 'workspace') return 'workspace-find';
    if (state.target.kind === 'folder') return 'path';
    return 'confirm';
  }
  if (isPhoneLayout) return 'dialog';
  if (state.openSlot === 'project' || (state.openSlot === 'model' && state.effortStepModelId === null)) {
    return 'find';
  }
  return 'selected-row';
}

export function decideActionOutcome(
  outcome: { readonly ok: true; readonly reply: ServerMessage } | { readonly ok: false; readonly error: Error },
  formatRefusal: (reply: ServerMessage) => string,
): AddSessionActionOutcomeDecision {
  if (outcome.ok && outcome.reply.type === 'add-session-result' && outcome.reply.ok) {
    return { kind: 'started', sessionId: outcome.reply.sessionId ?? null };
  }
  if (!outcome.ok) {
    return { kind: 'refused', errorText: outcome.error.message };
  }
  return { kind: 'refused', errorText: formatRefusal(outcome.reply) };
}

export function decideCloneJobProgress(
  repoFullName: string,
  job: RepositoryCloneJob | null,
  isUnsettled: boolean,
  statusText: string,
): { readonly kind: 'busy'; readonly statusText: string } | { readonly kind: 'done' } | { readonly kind: 'failed'; readonly errorText: string } {
  if (isUnsettled) return { kind: 'busy', statusText: `Cloning ${repoFullName}: ${statusText}` };
  if (job?.state === 'done') return { kind: 'done' };
  return { kind: 'failed', errorText: `${repoFullName} was not cloned: ${statusText}` };
}
