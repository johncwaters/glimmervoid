import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentModelCatalog } from '#shared/contracts/agent-models.ts';
import type { AgentAccountStatus } from '#shared/contracts/agent-accounts.ts';
import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import {
  accountSlotRowsOf,
  addSessionDisplayOf,
  agentSlotRowsOf,
  applyAccountsChanged,
  applyAgentsLoadError,
  applyAgentsListed,
  applyBackToModels,
  applyBackToProjects,
  applyFindInput,
  applyFindKeydown,
  applyFolderPathInput,
  applyGithubReposReply,
  applyLiveSettingsPayload,
  applyPickAccount,
  applyPickAgent,
  applyPickEffort,
  applyPickFolder,
  applyPickGithub,
  applyPickListedModel,
  applyPickProject,
  applyPickTypedModel,
  applyPickWorkspace,
  applyReopenSlot,
  applyRepoScanError,
  applyRepoScanReply,
  applySettingsLoadError,
  applySettingsMessage,
  applyStartPicksReply,
  applyToggleWorkspaceRepo,
  applyWorkBusy,
  applyWorkIdle,
  applyWorkspaceFindInput,
  beginAgentsLoad,
  beginRepoScan,
  beginSettingsLoad,
  buildIssueStartSubmission,
  buildPackLaunchSubmission,
  buildStartSubmission,
  createInitialAddSessionState,
  decideActionOutcome,
  decideFocusTarget,
  decidePathKeydown,
  modelSlotRowsOf,
  projectSlotRowsOf,
  workspacePanelRowsOf,
} from '../public/add-session/add-session-picker-core.ts';

const CATALOG = AgentModelCatalog.parse({
  agents: [
    {
      agent: 'claude-code',
      models: [
        {
          id: 'claude-sonnet-4-6',
          label: 'Sonnet 4.6',
          isDefault: true,
          aliases: [],
          options: [{ id: 'effort', label: 'Effort', choices: ['low', 'medium', 'high'], defaultChoice: 'medium' }],
        },
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5', isDefault: false, aliases: [], options: [] },
      ],
      configuredDefault: { model: 'claude-sonnet-4-6', effort: 'high' },
      error: null,
      checkedAt: 1,
    },
  ],
  openrouter: {
    models: [{ id: 'anthropic/claude-opus-4', label: 'Opus 4', isDefault: false, aliases: [], options: [] }],
    error: null,
    checkedAt: 1,
  },
});

const ACCOUNTS: AgentAccountStatus[] = [
  { agent: 'claude-code', accountId: null, label: 'Personal', plan: null, usedBy: [], lanes: [], isDefault: true, isPending: false, detail: null, login: { state: 'signed-in', reason: null, verificationUrl: null, userCode: null, needsPastedCode: false } },
  { agent: 'claude-code', accountId: 'work', label: 'Work', plan: null, usedBy: [], lanes: [], isDefault: false, isPending: false, detail: null, login: { state: 'signed-out', reason: null, verificationUrl: null, userCode: null, needsPastedCode: false } },
];

test('add-session-picker-core steps through agent, model/effort, account, and project picks with auto-submit when ready', () => {
  let state = createInitialAddSessionState({ isStudio: false, studioRepoDir: null });
  assert.equal(state.openSlot, 'agent');

  const agentsLoad = beginAgentsLoad(state);
  const agentsReply: ServerMessage = {
    type: 'agents-listed',
    agents: [
      { id: 'claude-code', label: 'Claude Code', resolvable: true, hidden: false },
      { id: 'shell', label: 'Shell', resolvable: true, hidden: false },
    ],
  } as ServerMessage;
  state = applyAgentsListed(agentsLoad.state, agentsLoad.loadNumber, agentsReply, [], () => ACCOUNTS, false, true).state;
  assert.equal(agentSlotRowsOf(state).length, 2);

  const settingsLoad = beginSettingsLoad(state);
  state = applySettingsMessage(settingsLoad.state, settingsLoad.loadNumber, {
    type: 'settings',
    settings: { saneYoloAvailable: true, saneYolo: true, agentModels: CATALOG },
  } as ServerMessage);

  state = applyRepoScanReply(beginRepoScan(state), {
    type: 'repo-roots-scanned',
    directories: [{ root: '/repos', projects: [{ name: 'alpha', path: '/repos/alpha', lastActivityMs: 1000 }, { name: 'beta', path: '/repos/beta', lastActivityMs: 2000 }] }],
    suggestions: [],
  } as ServerMessage, []);

  const afterAgent = applyPickAgent(state, 'claude-code', ACCOUNTS);
  state = afterAgent.state;
  assert.equal(state.openSlot, 'project');
  assert.equal(afterAgent.postAction, 'focus');

  state = applyReopenSlot(state, 'model').state;
  assert.equal(modelSlotRowsOf(state).some((row) => row.kind === 'model' && row.modelId === 'claude-sonnet-4-6'), true);
  const afterModel = applyPickListedModel(state, 'native', 'claude-sonnet-4-6');
  assert.equal(afterModel.state.effortStepModelId, 'claude-sonnet-4-6');
  assert.equal(modelSlotRowsOf(afterModel.state)[0]?.kind, 'back');
  assert.equal(applyBackToModels(afterModel.state).state.effortStepModelId, null);

  state = applyPickEffort(afterModel.state, 'high').state;
  assert.equal(state.openSlot, 'project');

  state = applyReopenSlot(state, 'account').state;
  assert.equal(accountSlotRowsOf(state, ACCOUNTS)[1]?.metaText, 'signed out');
  state = applyPickAccount(state, 'work', ACCOUNTS).state;
  const display = addSessionDisplayOf(state, ACCOUNTS, () => 'Work is signed out.');
  assert.equal(display.signInHintHidden, false);
  assert.equal(display.modelWordText, 'Sonnet 4.6 high');

  const projectRows = projectSlotRowsOf(state, () => null, () => '', 5000);
  const betaRow = projectRows.find((row) => row.kind === 'project' && row.name === 'beta');
  assert.ok(betaRow && betaRow.kind === 'project');
  const afterProject = applyPickProject(state, betaRow.row);
  assert.equal(afterProject.postAction, 'submit');

  const submission = buildStartSubmission(afterProject.state, {
    accounts: ACCOUNTS,
    readCloneJob: () => null,
    suggestName: (base) => base,
    defaultTimeoutMs: 15_000,
  });
  assert.equal(submission.kind, 'request');
  if (submission.kind === 'request') {
    assert.equal(submission.request.requestType, 'add-session');
    assert.equal(submission.request.message.agent, 'claude-code');
    assert.equal(submission.request.message.accountId, 'work');
    assert.deepEqual(submission.request.message.setup, { agent: 'claude-code', model: 'claude-sonnet-4-6', options: [{ id: 'effort', value: 'high' }] });
  }
});

test('add-session-picker-core handles workspace multi-repo O(R+P) partitioning, issue queries, IME guards, and failure states', () => {
  let state = createInitialAddSessionState({ isStudio: true, studioRepoDir: '/repos/studio' });
  assert.equal(state.target.kind, 'folder');
  assert.equal(state.folderPath, '/repos/studio');
  assert.equal(decideFocusTarget(state, false), 'selected-row');

  const load = beginAgentsLoad(state);
  state = applyAgentsListed(load.state, load.loadNumber, {
    type: 'agents-listed',
    agents: [{ id: 'claude-code', label: 'Claude Code', resolvable: true, hidden: false }],
  } as ServerMessage, [], () => [], false, false).state;
  state = applyPickAgent(state, 'claude-code', []).state;
  assert.equal(decideFocusTarget(state, false), 'path');
  assert.equal(decidePathKeydown('Enter', true), 'none');
  assert.equal(decidePathKeydown('Enter', false), 'submit');

  state = applyRepoScanReply(state, {
    type: 'repo-roots-scanned',
    directories: [{ root: '/repos', projects: [{ name: 'one', path: '/repos/one' }, { name: 'two', path: '/repos/two' }] }],
    suggestions: [],
  } as ServerMessage, []);
  state = applyStartPicksReply(state, { type: 'start-picks', picks: { version: 2, agentByPath: {}, selectionByAgent: {} } } as ServerMessage, []);
  state = applyGithubReposReply(state, [{ fullName: 'org/three', cloneUrl: 'https://github.com/org/three.git', isPrivate: true, pushedAt: null }]);
  state = applyBackToProjects(state).state;

  state = applyPickWorkspace(state).state;
  state = applyToggleWorkspaceRepo(state, '/repos/one');
  assert.equal(workspacePanelRowsOf(state).some((row) => row.kind === 'group-label' && row.text === 'Picked'), true);
  assert.equal(buildStartSubmission(state, { accounts: [], readCloneJob: () => null, suggestName: (base) => base, defaultTimeoutMs: 15_000 }).kind, 'error');

  state = applyWorkspaceFindInput(state, 'two');
  assert.equal(workspacePanelRowsOf(state).filter((row) => row.kind === 'repo' && !row.isPicked).length, 1);
  state = applyToggleWorkspaceRepo(state, '/repos/two');
  const workspaceSub = buildStartSubmission(state, { accounts: [], readCloneJob: () => null, suggestName: (base) => base, defaultTimeoutMs: 15_000 });
  assert.equal(workspaceSub.kind, 'request');

  state = applyBackToProjects(state).state;
  const loadedSettings = beginSettingsLoad(state);
  const readyForSubmit = applySettingsMessage(loadedSettings.state, loadedSettings.loadNumber, {
    type: 'settings',
    settings: { saneYolo: true, dangerouslySkipPermissions: false },
    saneYoloInstalled: true,
  } as ServerMessage);
  const firstRow = readyForSubmit.recentRows[0];
  assert.ok(firstRow);
  const pickedOne = applyPickProject(readyForSubmit, firstRow).state;
  const reopenedForFind = applyReopenSlot(pickedOne, 'project').state;
  const filteredMatch = applyFindInput(reopenedForFind, 'one');
  const visibleEnter = applyFindKeydown(filteredMatch, 'Enter', false);
  assert.equal(visibleEnter.kind, 'transition');
  if (visibleEnter.kind === 'transition') assert.equal(visibleEnter.transition.postAction, 'submit');
  const filteredMiss = applyFindInput(filteredMatch, 'zzzz-no-match');
  const hiddenEnter = applyFindKeydown(filteredMiss, 'Enter', false);
  assert.equal(hiddenEnter.kind, 'transition');
  if (hiddenEnter.kind === 'transition') assert.equal(hiddenEnter.transition.postAction, 'focus');

  const pendingDisplay = addSessionDisplayOf(state, [], () => '', true);
  assert.equal(pendingDisplay.isPickingLocked, true);
  assert.equal(pendingDisplay.confirmDisabled, true);
  assert.equal(pendingDisplay.startStatusHidden, false);
  assert.equal(pendingDisplay.startStatusText, 'Starting the session');

  const errAgentsLoad = beginAgentsLoad(state);
  const afterErrAgents = applyAgentsListed(errAgentsLoad.state, errAgentsLoad.loadNumber, {
    type: 'agents-listed',
    agents: [],
    error: 'Invalid list-agents payload',
  } as ServerMessage, [], () => [], false, false);
  assert.equal(afterErrAgents.state.selectedAgentId, 'claude-code');
  assert.equal(afterErrAgents.state.agentOptions.length, 1);

  const errSettingsLoad = beginSettingsLoad(state);
  const afterErrSettings = applySettingsMessage(errSettingsLoad.state, errSettingsLoad.loadNumber, {
    type: 'error',
    message: 'Invalid get-settings payload',
  } as ServerMessage);
  assert.equal(afterErrSettings.settingsState, 'failed');
  assert.ok(afterErrSettings.settingsWarning?.includes('Invalid get-settings payload'));

  state = applyFindInput(state, '#128');
  assert.equal(applyFindKeydown(state, 'Enter', true).kind, 'none');
  const issueKey = applyFindKeydown(state, 'Enter', false);
  assert.equal(issueKey.kind, 'start-issue');
  if (issueKey.kind === 'start-issue') {
    const issueSub = buildIssueStartSubmission(state, issueKey.project, issueKey.issueNumber, { accounts: [] });
    assert.equal(issueSub.kind, 'request');
    if (issueSub.kind === 'request') {
      assert.equal(issueSub.request.requestType, 'open-issue-session');
      assert.equal(issueSub.request.timeoutMs, 90_000);
    }
  }

  state = applyPickGithub(state, { fullName: 'org/three', cloneUrl: 'https://github.com/org/three.git', isPrivate: true, pushedAt: null }).state;
  assert.equal(buildStartSubmission(state, { accounts: [], readCloneJob: () => null, suggestName: (base) => base, defaultTimeoutMs: 15_000 }).kind, 'clone-then-submit');

  state = applyPickFolder(state).state;
  state = applyFolderPathInput(state, '/tmp/custom');
  state = applyPickTypedModel(state, 'native', 'custom-model').state;
  state = applyAccountsChanged(state, ACCOUNTS);
  state = applyLiveSettingsPayload(state, { saneYoloAvailable: false, saneYolo: true, agentModels: CATALOG });
  state = applyRepoScanError(state, 'timeout');
  const settingsLoad2 = beginSettingsLoad(state);
  state = applySettingsLoadError(settingsLoad2.state, settingsLoad2.loadNumber, 'boom');
  const agentsLoad2 = beginAgentsLoad(state);
  state = applyAgentsLoadError(agentsLoad2.state, agentsLoad2.loadNumber, 'boom', false, false).state;
  state = applyWorkBusy(state, 'Starting');
  assert.equal(buildPackLaunchSubmission(state, 'p', 'l', 15_000).kind, 'noop');
  state = applyWorkIdle(state, 'failed');
  assert.equal(buildPackLaunchSubmission(state, 'p', 'l', 15_000).kind, 'request');
  assert.equal(decideActionOutcome({ ok: false, error: new Error('refused') }, () => 'fallback').kind, 'refused');
});

test('add-session-picker-core resolves the same remembered model and effort across all 24 reply orders', () => {
  const startPicksMessage = {
    type: 'start-picks',
    picks: {
      version: 2,
      agentByPath: { '/repos/alpha-app': { agentId: 'claude-code', startedAtMs: 1000 } },
      selectionByAgent: {
        'claude-code': {
          selection: { agent: 'claude-code', provider: 'native', model: 'claude-sonnet-4-6', options: [{ id: 'effort', value: 'high' }] },
          pickedAtMs: 1,
          configuredAtPick: { model: 'claude-haiku-4-5', effort: null },
        },
      },
    },
  } as ServerMessage;
  const scanMessage = {
    type: 'repo-roots-scanned',
    directories: [{ root: '/repos', projects: [{ name: 'alpha-app', path: '/repos/alpha-app', lastActivityMs: 1000 }] }],
  } as ServerMessage;
  const agentsMessage = {
    type: 'agents-listed',
    agents: [
      { id: 'claude-code', label: 'Claude Code', resolvable: true },
      { id: 'codex', label: 'Codex', resolvable: true },
    ],
  } as ServerMessage;
  const settingsMessage = {
    type: 'settings',
    settings: {
      saneYoloAvailable: true,
      saneYolo: true,
      skipPermissionsByDefault: false,
      agentModels: {
        agents: [
          {
            agent: 'claude-code',
            models: [
              { id: 'claude-haiku-4-5', label: 'Haiku 4.5', isDefault: true, aliases: [], options: [] },
              {
                id: 'claude-sonnet-4-6',
                label: 'Sonnet 4.6',
                isDefault: false,
                aliases: [],
                options: [{ id: 'effort', label: 'Effort', choices: ['low', 'medium', 'high'], defaultChoice: 'medium' }],
              },
            ],
            configuredDefault: { model: 'claude-haiku-4-5', effort: null },
            error: null,
            checkedAt: 1,
          },
        ],
      },
    },
  } as ServerMessage;

  type ReplyStep = 'picks' | 'scan' | 'agents' | 'settings';
  const permutationsOf = (items: readonly ReplyStep[]): ReplyStep[][] => {
    if (items.length <= 1) return [[...items]];
    return items.flatMap((item, index) =>
      permutationsOf([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
    );
  };

  for (const order of permutationsOf(['picks', 'scan', 'agents', 'settings'])) {
    let state = createInitialAddSessionState({ isStudio: true, studioRepoDir: '/repos/alpha-app' });
    const agentsLoad = beginAgentsLoad(state);
    state = agentsLoad.state;
    const settingsLoad = beginSettingsLoad(state);
    state = settingsLoad.state;
    state = beginRepoScan(state);

    for (const step of order) {
      if (step === 'picks') state = applyStartPicksReply(state, startPicksMessage, []);
      if (step === 'scan') state = applyRepoScanReply(state, scanMessage, []);
      if (step === 'agents') {
        state = applyAgentsListed(state, agentsLoad.loadNumber, agentsMessage, [], () => [], false, true).state;
        state = applyPickAgent(state, 'claude-code', []).state;
      }
      if (step === 'settings') state = applySettingsMessage(state, settingsLoad.loadNumber, settingsMessage);
    }

    const display = addSessionDisplayOf(state, [], () => '');
    assert.equal(display.modelWordText, 'Sonnet 4.6 high', `order=${order.join(',')}`);
    assert.equal(display.repoWordText, 'alpha-app', `order=${order.join(',')}`);
  }
});
