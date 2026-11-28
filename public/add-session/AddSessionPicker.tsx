import { For, Match, Show, Switch, createEffect, createMemo, flush, onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { clock } from '#shared/clock.ts';
import type { ModelProvider } from '#shared/contracts/agent-models.ts';
import type { ApprovedPackLauncher } from '#shared/contracts/control/pack-messages.ts';
import { STATES } from '#shared/states.ts';
import { DEFAULT_REPLY_TIMEOUT_MS, paintActionStatus, requestFailureText } from '../action-status.ts';
import type { LiveSession, RecentRow, ScannedProject } from '../add-session-core.ts';
import { agentAccountSummary, agentAccountsOf, onAgentAccountsChanged, refreshAgentAccounts } from '../agent-logins.ts';
import { needsAttention } from '../attention-core.ts';
import { markAsNotCredential } from '../dom-helpers.ts';
import { cloneJobOf, cloneJobStatusText, isCloneJobUnsettled, onCloneJobsChanged, requestGithubRepos, requestRepositoryClones } from '../onboarding/clone-jobs.ts';
import { createRepoRootsAdder } from '../onboarding/repo-roots-adder.ts';
import { addSessionRefusalText, revealAddedSession } from '../session-actions.ts';
import { paintAgentChoiceMark } from '../session-card/agent-mark.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { suggestSessionName } from '../session-card/naming.ts';
import addSessionAction, {
  listAddSessionAgents,
  listStartPicks,
  requestAddSessionSettings,
  runStudioAddSession,
  scanRepoRoots,
} from '../state/actions/add-session.ts';
import openIssueSessionAction from '../state/actions/open-issue-session.ts';
import packLaunchAction from '../state/actions/pack-launch.ts';
import { packsSnapshot, watchPacksCollection } from '../state/collections/packs.ts';
import { hasPendingLaunch, watchPendingLaunches } from '../state/collections/sessions.ts';
import { settingsPayloadSnapshot } from '../state/collections/settings.ts';
import { Button } from '../ui/Button.tsx';
import { mountIsland } from '../ui/island.ts';
import { Pressable } from '../ui/Pressable.tsx';
import { createSyncedSignal } from '../ui/store-signal.ts';
import { AddSessionSlotList } from './AddSessionSlotList.tsx';
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
  decideCloneJobProgress,
  decideFocusTarget,
  decidePathKeydown,
  modelSlotRowsOf,
  projectSlotRowsOf,
  workspacePanelRowsOf,
} from './add-session-picker-core.ts';
import type { AddSessionRequestPayload, AddSessionSlot, AddSessionTransition, GithubRepo } from './add-session-picker-core.ts';

interface AddSessionPickerOptions {
  onStarted: () => void;
  onCancel?: () => void;
  onStudioStarted?: ((mainId: string) => void) | null;
  studioRepoDir?: string | null;
}

interface AddSessionPickerHandle {
  refresh: () => void;
  applyLiveSettings: () => void;
}

interface AddSessionPickerProps extends AddSessionPickerOptions {
  dialog: HTMLElement;
  onHandle: (handle: AddSessionPickerHandle) => void;
}

function readLiveSessions(): LiveSession[] {
  return [...sessionUIs.values()].map((ui) => ({
    path: ui.path,
    isRunning: ui.currentState === STATES.RUNNING,
    isWaiting: needsAttention({ state: ui.currentState, unseenOutcome: ui.unseenOutcome }),
  }));
}

const ACTION_DISPATCH_BY_TYPE: Record<
  AddSessionRequestPayload['requestType'],
  (request: AddSessionRequestPayload, isStudio: boolean) => ReturnType<typeof addSessionAction>
> = {
  'add-session': (request, isStudio) => {
    const payload = { ...(request.message as { name: string; path: string }), timeoutMs: request.timeoutMs };
    return isStudio ? runStudioAddSession({ ...payload, studio: true }) : addSessionAction(payload);
  },
  'pack-launch': (request) => packLaunchAction({ ...(request.message as { pack: string; launcherId: string }), timeoutMs: request.timeoutMs }),
  'open-issue-session': (request) => openIssueSessionAction({ ...(request.message as { path: string; issueNumber: number }), timeoutMs: request.timeoutMs }),
};

function dispatchActionRequest(request: AddSessionRequestPayload, isStudio: boolean) {
  return ACTION_DISPATCH_BY_TYPE[request.requestType](request, isStudio);
}

function focusElementByTarget(
  target: ReturnType<typeof decideFocusTarget>,
  refs: {
    dialog: HTMLElement;
    findInput?: HTMLInputElement;
    listEl?: HTMLDivElement;
    workspaceFindInput?: HTMLInputElement;
    pathInput?: HTMLInputElement;
    confirmBtn?: HTMLButtonElement;
  },
): void {
  const focusByTarget: Record<ReturnType<typeof decideFocusTarget>, () => void> = {
    none: () => {},
    dialog: () => refs.dialog.focus(),
    find: () => refs.findInput?.focus(),
    'selected-row': () => {
      const picked = refs.listEl?.querySelector<HTMLElement>('.add-session-row[aria-selected="true"]');
      (picked ?? refs.listEl?.querySelector<HTMLElement>('.add-session-row:not(:disabled)'))?.focus();
    },
    'workspace-find': () => refs.workspaceFindInput?.focus(),
    path: () => refs.pathInput?.focus(),
    confirm: () => refs.confirmBtn?.focus(),
  };
  focusByTarget[target]();
}

function AddSessionPicker(props: AddSessionPickerProps): JSX.Element {
  const isStudio = props.onStudioStarted !== null && props.onStudioStarted !== undefined;
  const pickerState = createSyncedSignal(createInitialAddSessionState({ isStudio, studioRepoDir: props.studioRepoDir ?? null }));
  const externalVersion = createSyncedSignal(0);

  let pickEl: HTMLDivElement | undefined;
  let findInputEl: HTMLInputElement | undefined;
  let listEl: HTMLDivElement | undefined;
  let workspacePanelEl: HTMLDivElement | undefined;
  let workspaceFindInputEl: HTMLInputElement | undefined;
  let folderPanelEl: HTMLDivElement | undefined;
  let pathInputEl: HTMLInputElement | undefined;
  let launchersEl: HTMLFieldSetElement | undefined;
  let confirmBtnEl: HTMLButtonElement | undefined;
  let agentMarkEl: HTMLSpanElement | undefined;
  let scanStatusEl: HTMLParagraphElement | undefined;
  let startStatusEl: HTMLParagraphElement | undefined;
  let repoRootsHostEl: HTMLDivElement | undefined;
  const wordElements = new Set<HTMLButtonElement>();

  const bumpExternal = () => externalVersion.update((count) => count + 1);
  const focusCurrent = () => focusElementByTarget(
    decideFocusTarget(pickerState.peek(), document.documentElement.dataset.layout === 'phone'),
    { dialog: props.dialog, findInput: findInputEl, listEl, workspaceFindInput: workspaceFindInputEl, pathInput: pathInputEl, confirmBtn: confirmBtnEl },
  );
  const isFocusAdrift = () => {
    const focused = document.activeElement;
    return focused === null || focused === document.body || focused === props.dialog || (focused instanceof HTMLButtonElement && wordElements.has(focused));
  };

  const applyTransition = (transition: AddSessionTransition, shouldFlush: boolean): void => {
    pickerState.update(transition.state);
    if (transition.syncFindValue !== null && findInputEl) findInputEl.value = transition.syncFindValue;
    if (shouldFlush) flush();
    switch (transition.postAction) {
      case 'none':
        return;
      case 'focus':
        focusCurrent();
        return;
      case 'submit':
        submitCurrent();
        return;
    }
  };

  const runRequest = (request: AddSessionRequestPayload): void => {
    if (request.requestType === 'add-session') pickerState.update((current) => applyWorkBusy(current, 'Starting the session'));
    void dispatchActionRequest(request, isStudio)
      .then((outcome) => {
        const startDecision = decideActionOutcome(outcome, addSessionRefusalText);
        if (startDecision.kind === 'refused') {
          pickerState.update((current) => applyWorkIdle(current, startDecision.errorText));
          return;
        }
        props.onStarted();
        const revealStarted = isStudio && request.requestType === 'add-session'
          ? (sessionId: string | null) => { if (sessionId) props.onStudioStarted?.(sessionId); }
          : revealAddedSession;
        revealStarted(startDecision.sessionId);
      })
      .finally(() => {
        pickerState.update((current) => applyWorkIdle(current));
        if (props.dialog.isConnected && isFocusAdrift()) focusCurrent();
      });
  };

  const cloneThenSubmit = async (repo: GithubRepo): Promise<void> => {
    pickerState.update((current) => applyWorkBusy(current, `Cloning ${repo.fullName}`));
    const failure = isCloneJobUnsettled(cloneJobOf(repo.cloneUrl)) ? null : await requestRepositoryClones([repo.cloneUrl]);
    if (failure !== null) {
      pickerState.update((current) => applyWorkIdle(current, failure));
      return;
    }
    const stopWatching = onCloneJobsChanged(followClone);
    followClone();
    function followClone() {
      if (!props.dialog.isConnected) {
        stopWatching();
        return;
      }
      const job = cloneJobOf(repo.cloneUrl);
      const step = decideCloneJobProgress(repo.fullName, job, isCloneJobUnsettled(job), cloneJobStatusText(job));
      switch (step.kind) {
        case 'busy':
          pickerState.update((current) => applyWorkBusy(current, step.statusText));
          return;
        case 'done':
          stopWatching();
          pickerState.update((current) => applyWorkIdle(current));
          submitCurrent();
          return;
        case 'failed':
          stopWatching();
          pickerState.update((current) => applyWorkIdle(current, step.errorText));
          return;
      }
    }
  };

  const executeSubmission = (decision: ReturnType<typeof buildStartSubmission>): void => {
    switch (decision.kind) {
      case 'noop':
        return;
      case 'error':
        pickerState.update(decision.state);
        return;
      case 'clone-then-submit':
        pickerState.update(decision.state);
        void cloneThenSubmit(decision.repo);
        return;
      case 'request':
        pickerState.update(decision.state);
        runRequest(decision.request);
        return;
    }
  };

  const submitCurrent = (): void => {
    const state = pickerState.peek();
    executeSubmission(buildStartSubmission(state, {
      accounts: agentAccountsOf(state.selectedAgentId),
      readCloneJob: cloneJobOf,
      suggestName: suggestSessionName,
      defaultTimeoutMs: DEFAULT_REPLY_TIMEOUT_MS,
      hasPendingLaunch: hasPendingLaunch(),
    }));
  };

  const startIssueSession = (project: ScannedProject, issueNumber: number): void => {
    const state = pickerState.peek();
    const decision = buildIssueStartSubmission(state, project, issueNumber, {
      accounts: agentAccountsOf(state.selectedAgentId),
      hasPendingLaunch: hasPendingLaunch(),
    });
    if (decision.kind !== 'noop' && findInputEl) findInputEl.value = '';
    executeSubmission(decision);
  };

  const fillProjectList = () => {
    pickerState.update(beginRepoScan);
    return scanRepoRoots()
      .then((message) => {
        pickerState.update((current) => applyRepoScanReply(current, message, readLiveSessions()));
      })
      .catch((reason: unknown) => {
        pickerState.update((current) => applyRepoScanError(current, requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS)));
      });
  };

  const loadAgents = () => {
    const started = beginAgentsLoad(pickerState.peek());
    pickerState.update(started.state);
    return listAddSessionAgents(isStudio)
      .then((message) => {
        const insidePick = Boolean(pickEl?.contains(document.activeElement));
        applyTransition(
          applyAgentsListed(pickerState.peek(), started.loadNumber, message, readLiveSessions(), agentAccountsOf, insidePick, isFocusAdrift()),
          true,
        );
      })
      .catch((reason: unknown) => {
        const insidePick = Boolean(pickEl?.contains(document.activeElement));
        applyTransition(
          applyAgentsLoadError(pickerState.peek(), started.loadNumber, requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS), insidePick, isFocusAdrift()),
          true,
        );
      });
  };

  const loadSettings = () => {
    const started = beginSettingsLoad(pickerState.peek());
    pickerState.update(started.state);
    return requestAddSessionSettings()
      .then((message) => {
        pickerState.update((current) => applySettingsMessage(current, started.loadNumber, message));
      })
      .catch((reason: unknown) => {
        pickerState.update((current) => applySettingsLoadError(current, started.loadNumber, requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS)));
      });
  };

  const refresh = () => {
    void listStartPicks()
      .then((message) => {
        pickerState.update((current) => applyStartPicksReply(current, message, readLiveSessions()));
      })
      .catch(() => {});
    void fillProjectList();
    void requestGithubRepos().then((listing) => {
      if (listing.kind === 'listed') pickerState.update((current) => applyGithubReposReply(current, listing.repos));
    });
    void loadAgents();
    void loadSettings();
  };

  const applyLiveSettings = () => {
    pickerState.update((current) => applyLiveSettingsPayload(current, settingsPayloadSnapshot()));
  };

  props.onHandle({ refresh, applyLiveSettings });

  const display = createMemo(() => {
    externalVersion.read();
    const state = pickerState.read();
    return addSessionDisplayOf(state, agentAccountsOf(state.selectedAgentId), agentAccountSummary, hasPendingLaunch());
  });
  const agentRows = createMemo(() => agentSlotRowsOf(pickerState.read()));
  const accountRows = createMemo(() => {
    externalVersion.read();
    const state = pickerState.read();
    return accountSlotRowsOf(state, agentAccountsOf(state.selectedAgentId));
  });
  const modelRows = createMemo(() => modelSlotRowsOf(pickerState.read()));
  const projectRows = createMemo(() => {
    externalVersion.read();
    return projectSlotRowsOf(pickerState.read(), cloneJobOf, cloneJobStatusText, clock.nowMs());
  });
  const workspaceRows = createMemo(() => workspacePanelRowsOf(pickerState.read()));
  const launchers = createMemo<readonly ApprovedPackLauncher[]>(() => {
    externalVersion.read();
    return packsSnapshot()?.launchers ?? [];
  });

  const repoRootsAdder = createRepoRootsAdder({ onAdded: () => { void fillProjectList(); } });

  createEffect(
    () => [display().agentMarkId, display().agentMarkLabel] as const,
    ([markId, markLabel]) => {
      if (agentMarkEl) paintAgentChoiceMark(agentMarkEl, markId, markLabel);
    },
  );
  createEffect(
    () => [display().scanStatusTone, display().scanStatusText, pickerState.read().scanState] as const,
    ([tone, text, scanState]) => {
      if (scanState.kind === 'empty') repoRootsAdder.setSuggestions(scanState.suggestions);
      if (scanStatusEl) paintActionStatus(scanStatusEl, tone, text);
    },
  );
  createEffect(
    () => [display().startStatusTone, display().startStatusText] as const,
    ([tone, text]) => {
      if (startStatusEl) paintActionStatus(startStatusEl, tone, text);
    },
  );
  createEffect(
    () => display().isPickingLocked,
    (isLocked) => {
      const regions = [pickEl, workspacePanelEl, folderPanelEl, launchersEl].filter((el): el is NonNullable<typeof el> => el !== undefined);
      if (isLocked && regions.some((region) => region.contains(document.activeElement))) props.dialog.focus();
      for (const region of regions) region.inert = isLocked;
    },
  );

  onSettled(() => {
    if (repoRootsHostEl) repoRootsHostEl.append(repoRootsAdder.element);
    if (props.studioRepoDir !== null && props.studioRepoDir !== undefined && pathInputEl) {
      pathInputEl.value = props.studioRepoDir;
    }
    const stopAccounts = onAgentAccountsChanged(() => {
      pickerState.update((current) => applyAccountsChanged(current, agentAccountsOf(current.selectedAgentId)));
      bumpExternal();
    });
    const stopClones = onCloneJobsChanged(bumpExternal);
    const stopPacks = watchPacksCollection(bumpExternal);
    const stopLaunches = watchPendingLaunches(bumpExternal);
    refreshAgentAccounts();
    refresh();
    return () => {
      stopAccounts();
      stopClones();
      stopPacks();
      stopLaunches();
    };
  });

  const openSlotFromWord = (slot: AddSessionSlot) => applyTransition(applyReopenSlot(pickerState.peek(), slot), true);
  const registerWord = (element: HTMLButtonElement) => { wordElements.add(element); };

  return (
    <>
      <h2 class="dialog-title" id="add-session-title">What are we working on?</h2>
      <p class="add-session-sentence">
        Start{' '}
        <Pressable
          ref={registerWord}
          class="add-session-word"
          data-placeholder={display().agentWordPlaceholder}
          disabled={display().agentWordDisabled}
          aria-expanded={display().expandedBySlot.agent}
          onClick={() => openSlotFromWord('agent')}
        >
          <span
            class="agent-mark"
            hidden={display().agentMarkId === null}
            ref={(element) => {
              agentMarkEl = element;
              element.setAttribute('aria-hidden', 'true');
            }}
          />
          <span>{display().agentWordText}</span>
        </Pressable>
        {' as '}
        <Pressable
          ref={registerWord}
          class="add-session-word"
          data-placeholder={display().accountWordPlaceholder}
          disabled={display().accountWordDisabled}
          aria-expanded={display().expandedBySlot.account}
          onClick={() => openSlotFromWord('account')}
        >
          {display().accountWordText}
        </Pressable>
        {' on '}
        <Pressable
          ref={registerWord}
          class="add-session-word"
          data-placeholder={display().modelWordPlaceholder}
          disabled={display().modelWordDisabled}
          aria-expanded={display().expandedBySlot.model}
          onClick={() => openSlotFromWord('model')}
        >
          {display().modelWordText}
        </Pressable>
        {' in '}
        <Pressable
          ref={registerWord}
          class="add-session-word add-session-repo-word"
          data-placeholder={display().repoWordPlaceholder}
          disabled={display().repoWordDisabled}
          aria-expanded={display().expandedBySlot.project}
          onClick={() => openSlotFromWord('project')}
        >
          {display().repoWordText}
        </Pressable>
      </p>
      <fieldset
        ref={(element) => { launchersEl = element; }}
        class="add-session-launchers"
        id="add-session-launchers"
        aria-label="Pack launchers"
        hidden={launchers().length === 0}
      >
        <For each={launchers()}>
          {(launcher) => (
            <div class="add-session-launcher">
              <Button
                variant="secondary"
                label={launcher.label}
                disabled={launcher.disabledReason !== null}
                onClick={() => executeSubmission(buildPackLaunchSubmission(pickerState.peek(), launcher.pack, launcher.id, DEFAULT_REPLY_TIMEOUT_MS, hasPendingLaunch()))}
              />
              <span class="dialog-hint">{launcher.disabledReason ?? `${launcher.agent} in ${launcher.project}`}</span>
            </div>
          )}
        </For>
      </fieldset>
      <div
        ref={(element) => { pickEl = element; }}
        class="add-session-pick"
        id="add-session-pick"
        hidden={display().pickHidden}
        data-slot={display().pickDataSlot}
      >
        <div class="add-session-top">
          <p class="add-session-slot-title" id="add-session-slot-title">{display().slotTitle}</p>
          <input
            ref={(element) => { findInputEl = markAsNotCredential(element); }}
            type="text"
            class="dialog-input add-session-find"
            id="add-session-find"
            placeholder={display().findPlaceholder}
            autocomplete="off"
            spellcheck={false}
            aria-label={display().findPlaceholder}
            onInput={(event) => {
              pickerState.update((current) => applyFindInput(current, event.currentTarget.value));
            }}
            onKeyDown={(event) => {
              const keyAction = applyFindKeydown(pickerState.peek(), event.key, event.isComposing);
              if (keyAction.kind === 'none') return;
              event.preventDefault();
              if (keyAction.kind === 'start-issue') {
                startIssueSession(keyAction.project, keyAction.issueNumber);
                return;
              }
              applyTransition(keyAction.transition, true);
            }}
          />
        </div>
        <div
          ref={(element) => { listEl = element; }}
          class="add-session-list"
          id="add-session-list"
          role="listbox"
          aria-label={display().listAriaLabel}
        >
          <AddSessionSlotList
            openSlot={pickerState.read().openSlot}
            agentRows={agentRows()}
            accountRows={accountRows()}
            modelRows={modelRows()}
            projectRows={projectRows()}
            onPickAgent={(agentId) => applyTransition(applyPickAgent(pickerState.peek(), agentId, agentAccountsOf(agentId)), true)}
            onPickAccount={(accountValue) => applyTransition(applyPickAccount(pickerState.peek(), accountValue, agentAccountsOf(pickerState.peek().selectedAgentId)), true)}
            onPickModel={(provider: ModelProvider, modelId: string) => applyTransition(applyPickListedModel(pickerState.peek(), provider, modelId), true)}
            onPickTypedModel={(provider: ModelProvider, modelId: string) => applyTransition(applyPickTypedModel(pickerState.peek(), provider, modelId), true)}
            onPickEffort={(effort) => applyTransition(applyPickEffort(pickerState.peek(), effort), true)}
            onBackToModels={() => applyTransition(applyBackToModels(pickerState.peek()), true)}
            onPickIssue={startIssueSession}
            onPickProject={(row: RecentRow) => applyTransition(applyPickProject(pickerState.peek(), row), true)}
            onPickGithub={(repo: GithubRepo) => applyTransition(applyPickGithub(pickerState.peek(), repo), true)}
            onPickChoice={(choice) => applyTransition(choice === 'workspace' ? applyPickWorkspace(pickerState.peek()) : applyPickFolder(pickerState.peek()), true)}
          />
        </div>
        <div class="add-session-scan flex items-center gap-2">
          <p
            ref={(element) => {
              scanStatusEl = element;
              element.setAttribute('role', 'status');
            }}
            class={display().scanStatusClassName}
            hidden={display().scanStatusHidden}
          />
          <Button
            variant="secondary"
            label="Scan again"
            hidden={display().scanAgainHidden}
            disabled={display().scanAgainDisabled}
            onClick={() => { void fillProjectList(); }}
          />
        </div>
        <div
          ref={(element) => { repoRootsHostEl = element; }}
          class="dialog-repo-roots"
          id="add-session-repo-roots"
          hidden={display().repoRootsHidden}
        >
          <p class="dialog-repo-roots-title" id="add-session-repo-roots-title">Add a repository</p>
          <p class="dialog-repo-roots-desc">Add the folder that holds your git checkouts. Its repos show up right here.</p>
        </div>
      </div>
      <div
        ref={(element) => { workspacePanelEl = element; }}
        class="add-session-panel"
        id="add-session-workspace"
        hidden={display().workspaceHidden}
      >
        <div class="add-session-top">
          <input
            ref={(element) => { workspaceFindInputEl = markAsNotCredential(element); }}
            type="text"
            class="dialog-input add-session-find"
            id="add-session-workspace-find"
            placeholder="Find a repository"
            autocomplete="off"
            spellcheck={false}
            aria-label="Find a repository"
            onInput={(event) => {
              pickerState.update((current) => applyWorkspaceFindInput(current, event.currentTarget.value));
            }}
          />
        </div>
        <div class="add-session-list" id="add-session-workspace-list" role="listbox" aria-multiselectable="true" aria-label="Workspace repositories">
          <For each={workspaceRows()} keyed={(row) => row.key}>
            {(row) => (
              <Switch>
                <Match when={row().kind === 'back'}>
                  <Pressable
                    class="add-session-row add-session-row-back"
                    data-key={row().key}
                    onClick={() => applyTransition(applyBackToProjects(pickerState.peek()), true)}
                  >
                    <span class="add-session-row-chevron" />
                    <span class="add-session-row-name">All projects</span>
                  </Pressable>
                </Match>
                <Match when={row().kind === 'group-label'}>
                  <div class="add-session-list-label" role="presentation">
                    {(row() as { kind: 'group-label'; text: string }).text}
                  </div>
                </Match>
                <Match when={row().kind === 'repo'}>
                  <Pressable
                    class="add-session-row"
                    role="option"
                    aria-selected={(row() as { kind: 'repo'; isPicked: boolean }).isPicked ? 'true' : 'false'}
                    data-key={row().key}
                    onClick={(event) => {
                      const clickedRow = event.currentTarget;
                      pickerState.update((current) => applyToggleWorkspaceRepo(current, (row() as { kind: 'repo'; path: string }).path));
                      flush();
                      if (clickedRow.isConnected) clickedRow.focus();
                    }}
                  >
                    <span class="add-session-row-tick" />
                    <span class="add-session-row-name">{(row() as { kind: 'repo'; name: string }).name}</span>
                  </Pressable>
                </Match>
              </Switch>
            )}
          </For>
        </div>
      </div>
      <div
        ref={(element) => { folderPanelEl = element; }}
        class="add-session-panel"
        id="add-session-folder"
        hidden={display().folderHidden}
      >
        <div class="add-session-top">
          <input
            ref={(element) => { pathInputEl = markAsNotCredential(element); }}
            type="text"
            class="dialog-input"
            id="add-session-path"
            placeholder="Full path to the folder"
            autocomplete="off"
            spellcheck={false}
            aria-label="Folder path"
            onInput={(event) => {
              pickerState.update((current) => applyFolderPathInput(current, event.currentTarget.value));
            }}
            onKeyDown={(event) => {
              if (decidePathKeydown(event.key, event.isComposing) === 'submit') submitCurrent();
            }}
          />
        </div>
        <div class="add-session-list" id="add-session-folder-list" role="listbox" aria-label="Folder">
          <Pressable
            class="add-session-row add-session-row-back"
            data-key="back:All projects"
            onClick={() => applyTransition(applyBackToProjects(pickerState.peek()), true)}
          >
            <span class="add-session-row-chevron" />
            <span class="add-session-row-name">All projects</span>
          </Pressable>
        </div>
      </div>
      <p class="dialog-hint" id="add-session-sign-in" role="status" hidden={display().signInHintHidden}>
        {display().signInHintText}
      </p>
      <p class="dialog-hint" id="add-session-unprotected" hidden={display().unprotectedHintHidden}>
        {display().unprotectedHintText}
      </p>
      <Show when={pickerState.read().agentWarning}>
        {(warning) => (
          <p class="dialog-hint dialog-hint-warning" role="status" id={warning().id ?? undefined}>
            {warning().text}
          </p>
        )}
      </Show>
      <Show when={pickerState.read().settingsWarning}>
        {(warning) => (
          <p class="dialog-hint dialog-hint-warning" role="status">
            {warning()}
          </p>
        )}
      </Show>
      <div class="dialog-error add-session-message" id="add-session-error">
        {pickerState.read().errorText}
      </div>
      <div class="dialog-actions add-session-actions" id="add-session-actions">
        <p
          ref={(element) => {
            startStatusEl = element;
            element.setAttribute('role', 'status');
          }}
          class={display().startStatusClassName}
          hidden={display().startStatusHidden}
        />
        <Show when={props.onCancel}>
          {(onCancel) => <Button variant="secondary" label="Cancel" onClick={() => onCancel()()} />}
        </Show>
        <Button
          ref={(element) => { confirmBtnEl = element; }}
          variant="primary"
          label="Start session"
          disabled={display().confirmDisabled}
          onClick={submitCurrent}
        />
      </div>
    </>
  );
}

export function mountAddSessionPicker(dialog: HTMLElement, options: AddSessionPickerOptions): AddSessionPickerHandle {
  const handleBox: { current: AddSessionPickerHandle } = { current: { refresh: () => {}, applyLiveSettings: () => {} } };
  mountIsland(dialog, () => (
    <AddSessionPicker
      dialog={dialog}
      onStarted={options.onStarted}
      onCancel={options.onCancel}
      onStudioStarted={options.onStudioStarted}
      studioRepoDir={options.studioRepoDir}
      onHandle={(nextHandle) => { handleBox.current = nextHandle; }}
    />
  ));
  return {
    refresh: () => handleBox.current.refresh(),
    applyLiveSettings: () => handleBox.current.applyLiveSettings(),
  };
}
