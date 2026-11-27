import { For, Show, createEffect, createMemo, createSignal, onCleanup, onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { operatorPartOfPrompt } from '#shared/board-branch-core.ts';
import { clock } from '#shared/clock.ts';
import type { SessionProgressAnswer } from '#shared/contracts/director-digests.ts';
import type { ChatOutboxEntry } from '#shared/contracts/session.ts';
import { errorMessage } from '#shared/text.ts';
import { createChatActivity } from '../chat/chat-activity.ts';
import type { ActivityBeat, ChatPhase } from '../chat/chat-activity-core.ts';
import { renderStudioCard } from '../chat/chat-cards.ts';
import { createChatFeed } from '../chat/chat-feed.ts';
import type { ChatFeed } from '../chat/chat-feed.ts';
import { draftWithRestoredText, stringDetailOf } from '../chat/chat-page.ts';
import type { ChatPart } from '../chat/chat-part.ts';
import { chatDraftOf, saveChatDraft, scheduleChatDraftSave } from '../chat/chat-session-state.ts';
import { studioQueuedStatusOf } from '../chat/chat-view.ts';
import { createComposer } from '../chat/composer.ts';
import { listenForModelChange } from '../chat/model-picker.ts';
import type { RailField } from '../chat/status-rail-core.ts';
import { stickToBottom } from '../chat/stick-to-bottom.ts';
import { parsePlanMarkdown } from '../plan/plan-markdown-core.ts';
import { renderPlanBlocks } from '../plan/plan-render.ts';
import { paintAgentMark } from '../session-card/agent-mark.ts';
import { canSwitchSessionModel } from '../session-card/card-model.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import branchSpawnAction from '../state/actions/branch-spawn.ts';
import chatCancelAction from '../state/actions/chat-cancel.ts';
import chatSendAction from '../state/actions/chat-send.ts';
import chatStopAction from '../state/actions/chat-stop.ts';
import studioProgressAskAction from '../state/actions/studio-progress-ask.ts';
import {
  createChatOutboxProjection,
  takeStandInsForPrompts,
} from '../state/chat-outbox-core.ts';
import { watchChatOutbox } from '../state/collections/chat-outbox.ts';
import { requestSessionTracePage } from '../state/collections/sessions.ts';
import { createLineIcon } from '../svg-dom.ts';
import { Button } from '../ui/Button.tsx';
import { mountIsland } from '../ui/island.ts';
import { createSyncedSignal } from '../ui/store-signal.ts';
import { Pressable } from '../ui/Pressable.tsx';
import { labelIconPressable } from '../ui/pressable.ts';
import { onAgentChange } from '../whiteboard/board-tile-store.ts';
import type { AgentChip } from '../whiteboard/board-tile-store.ts';
import { addressLabelOf } from './branch-core.ts';
import type { BoxChoice, DockAddress } from './branch-core.ts';
import {
  EMPTY_MENTION_STATE,
  MAIN_ADDRESS,
  activeDescendantIdOf,
  addressedSessionIdOf,
  applyPartsChanged,
  applySessionRebuilt,
  applySessionReset,
  createInitialLogState,
  createInitialQueueState,
  decideBranchSpawnReply,
  decideCancelReply,
  decideMentionKeydown,
  enqueuePendingSend,
  groupMentionChoices,
  hasFailedOutboxEntry,
  isAddressedSessionTurnRunning,
  isImmediateDraftEvent,
  isOutboxCancelDisabled,
  isTargetSessionTurnRunning,
  markPendingSendDispatched,
  markPendingSendOutcome,
  maxLengthForAddress,
  pickDockMentionChoice,
  planSendDispatch,
  readDockMention,
  reconcileDockBranches,
  reconcileDockQueue,
  reconcileOutboxEcho,
  replyTextsOf,
  resolveAddressForBox,
  resolveAddressForBranch,
  resolveAddressForSession,
  selectAttributionBySessionId,
  selectMergedLogRows,
  selectTurnDisplay,
  setCancellingEntry,
  setLogProgressAnswers,
  settleDockPendingSend,
  shouldFoldLogOnBlur,
  shouldOpenLogOnRefresh,
  toggleExpandedRowKey,
} from './dock-core.ts';
import type {
  DockBranchDescriptor,
  FeedSpeaker,
  PartRowEntry,
  ProgressAnswerRowEntry,
  ProgressQuestionRowEntry,
} from './dock-core.ts';

const TRACE_PAGE_TIMEOUT_MS = 10_000;
const GLIMMERVOID_NAME = 'Glimmervoid';
const NEAR_TOP_PX = 48;
const CLEAR_ICON_PATH = 'M4 4l8 8M12 4l-8 8';
const RAIL_TICK_MS = 30_000;
const NO_UPLOADS_URL = '';
const KEPT_BOARD_CHANGES_PER_SESSION_MAX = 50;

const boardChangesBySessionId = new Map<string, AgentChip[]>();
onAgentChange((sessionId, boardChange) => {
  boardChangesBySessionId.set(
    sessionId,
    [...(boardChangesBySessionId.get(sessionId) ?? []), boardChange].slice(-KEPT_BOARD_CHANGES_PER_SESSION_MAX),
  );
});

interface DockActivity {
  phase: ChatPhase;
  beat: ActivityBeat | null;
}

type DockDelivery = 'talk' | 'branch' | 'progress';

interface DockSession {
  sessionId: string;
  name: string;
  workingDirectory: string | null;
  agentId: string | null;
  isTurnOver: () => boolean;
  hasFailure: () => boolean;
  boxChoices: () => readonly BoxChoice[];
  digestOf: (sessionId: string, openedAt: number) => string | null;
  progressAnswers: () => readonly SessionProgressAnswer[];
  railFields: (canChangeModel: boolean) => readonly RailField[];
  onDelivered: (kind: DockDelivery) => void;
  outbox: () => readonly ChatOutboxEntry[];
  activity: () => DockActivity;
  mapBoardId: () => string | null;
  showBoardChange: (sessionId: string, boardChange: AgentChip) => void;
}

export interface DockBranch extends DockBranchDescriptor {
  isTurnOver: () => boolean;
}

export interface DockHandle {
  setBranches(branches: readonly DockBranch[]): void;
  addressSession(sessionId: string | null, name: string): void;
  addressBox(boxId: string, title: string): void;
  refresh(): void;
  refreshDigests(): void;
  paintActivity(): void;
  close(): void;
}

interface DockProps {
  session: DockSession;
  onHandle: (handle: DockHandle) => void;
}

function isInsideFullReply(eventTarget: EventTarget | null): boolean {
  return eventTarget instanceof Element && eventTarget.closest('.bs-full-reply, .bs-reply-actions') !== null;
}

function isOutsideElement(container: HTMLElement | undefined, target: EventTarget | null): boolean {
  return container !== undefined && target instanceof Node && !container.contains(target);
}

function renderMarkdownInto(container: HTMLElement, text: string): void {
  container.replaceChildren(renderPlanBlocks(parsePlanMarkdown(text)));
}

function renderFullReplyInto(container: HTMLElement, part: Extract<ChatPart, { kind: 'turn' }>): void {
  const blocks = replyTextsOf(part).map((replyText) => renderPlanBlocks(parsePlanMarkdown(replyText)));
  container.replaceChildren(...blocks);
}

function markdownDirective(source: () => string): (element: HTMLElement) => void {
  let targetElement: HTMLElement | undefined;
  createEffect(source, (text) => {
    if (targetElement) renderMarkdownInto(targetElement, text);
  });
  return (nextElement) => {
    targetElement = nextElement;
    renderMarkdownInto(nextElement, source());
  };
}

function fullReplyDirective(source: () => Extract<ChatPart, { kind: 'turn' }>): (element: HTMLElement) => void {
  let targetElement: HTMLElement | undefined;
  createEffect(source, (turnPart) => {
    if (targetElement) renderFullReplyInto(targetElement, turnPart);
  });
  return (nextElement) => {
    targetElement = nextElement;
    renderFullReplyInto(nextElement, source());
  };
}

function agentMarkDirective(
  source: () => { agentId: string | null; name: string },
): (element: HTMLElement) => void {
  let targetElement: HTMLElement | undefined;
  createEffect(source, ({ agentId, name }) => {
    if (targetElement) paintAgentMark(targetElement, agentId, name);
  });
  return (nextElement) => {
    targetElement = nextElement;
    const initial = source();
    paintAgentMark(nextElement, initial.agentId, initial.name);
  };
}

function cardNodeDirective(source: () => HTMLElement): (element: HTMLElement) => void {
  let targetElement: HTMLElement | undefined;
  createEffect(source, (cardNode) => {
    if (targetElement) targetElement.replaceChildren(cardNode);
  });
  return (nextElement) => {
    targetElement = nextElement;
    nextElement.replaceChildren(source());
  };
}

function ariaExpandedDirective(source: () => boolean): (element: HTMLElement) => void {
  let targetElement: HTMLElement | undefined;
  createEffect(source, (expanded) => {
    if (targetElement) targetElement.setAttribute('aria-expanded', String(expanded));
  });
  return (nextElement) => {
    targetElement = nextElement;
    nextElement.setAttribute('aria-expanded', String(source()));
  };
}

function bindPressableElement(target: HTMLElement, label: string, press: () => void): void {
  target.tabIndex = 0;
  target.setAttribute('role', 'button');
  target.setAttribute('aria-label', label);
  target.addEventListener('click', (event) => {
    if (isInsideFullReply(event.target)) return;
    event.stopPropagation();
    press();
  });
  target.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (isInsideFullReply(event.target)) return;
    event.preventDefault();
    press();
  });
}

function Dock(props: DockProps): JSX.Element {
  let dockElement: HTMLElement | undefined;
  let logElement: HTMLDivElement | undefined;
  let logContentElement: HTMLDivElement | undefined;
  let jumpSlotElement: HTMLDivElement | undefined;
  let addressChipElement: HTMLSpanElement | undefined;

  const mainSpeaker: FeedSpeaker<DockBranch> = {
    sessionId: props.session.sessionId,
    name: props.session.name,
    agentId: props.session.agentId,
    branch: null,
  };

  const isLogOpenState = createSyncedSignal<boolean>(false);
  const [failureText, setFailureText] = createSignal<string | null>(null);
  const addressState = createSyncedSignal<DockAddress>(MAIN_ADDRESS);
  const mentionState = createSyncedSignal(EMPTY_MENTION_STATE);
  const logState = createSyncedSignal(createInitialLogState<DockBranch>(mainSpeaker));
  const queueState = createSyncedSignal(createInitialQueueState());
  const [expandedRowKeys, setExpandedRowKeys] = createSignal<ReadonlySet<string>>(new Set());
  const [digestVersion, setDigestVersion] = createSignal(0);
  const [boardChangeVersion, setBoardChangeVersion] = createSignal(0);

  const mentionItems = createMemo(() => groupMentionChoices(mentionState.read().choices));
  const addressLabel = createMemo(() => addressLabelOf(addressState.read()));
  const mergedLogRows = createMemo(() => selectMergedLogRows(logState.read()));
  const attributionBySessionId = createMemo(() => {
    boardChangeVersion();
    return selectAttributionBySessionId(logState.read(), boardChangesBySessionId, props.session.mapBoardId());
  });

  const feedBySessionId = new Map<string, ChatFeed>();
  const branchTurnOverBySessionId = new Map<string, () => boolean>();
  const entryIdsAwaitingPrompt = new Set<string>();
  const outboxProjection = createChatOutboxProjection();

  let mainSendQueue: Promise<string | null> = Promise.resolve(null);
  let shownActivityBeat: ActivityBeat | null = null;
  let dockLifecycle: 'open' | 'closed' = 'open';
  let composerRef: ReturnType<typeof createComposer> | null = null;
  let activityRef: ReturnType<typeof createChatActivity> | null = null;
  let followLatestFn: () => void = () => {};
  let mainFeedRef: ChatFeed | null = null;
  let cleanupResources: () => void = () => {};

  const isBranchTurnOver = (sessionId: string): boolean => branchTurnOverBySessionId.get(sessionId)?.() ?? true;

  const isAddressedTurnRunning = (): boolean => isAddressedSessionTurnRunning(
    addressState.peek(),
    props.session.sessionId,
    props.session.isTurnOver(),
    (sessionId) => feedBySessionId.has(sessionId),
    isBranchTurnOver,
  );

  const syncInputActiveDescendant = (): void => {
    const input = composerRef?.input;
    if (!input) return;
    const activeId = activeDescendantIdOf(mentionState.peek());
    if (activeId === null) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    input.setAttribute('aria-activedescendant', activeId);
  };

  const closeMentions = (): void => {
    mentionState.update(EMPTY_MENTION_STATE);
    syncInputActiveDescendant();
  };

  const paintComposer = (): void => {
    if (!composerRef) return;
    composerRef.setTurnRunning(isAddressedTurnRunning());
    composerRef.showRail(props.session.railFields(canSwitchSessionModel(props.session.sessionId) && props.session.isTurnOver()));
  };

  const setAddress = (nextAddress: DockAddress): void => {
    addressState.update(nextAddress);
    if (composerRef) composerRef.input.maxLength = maxLengthForAddress(nextAddress);
    paintComposer();
  };

  const pickChoice = (choice: BoxChoice): void => {
    if (!composerRef) return;
    const picked = pickDockMentionChoice(mentionState.peek(), composerRef.input.value, choice);
    if (picked === null) return;
    composerRef.input.value = picked.nextInputValue;
    closeMentions();
    setAddress(picked.nextAddress);
    composerRef.restoreDraft(composerRef.input.value);
    composerRef.input.focus();
  };

  const readMention = (): void => {
    const input = composerRef?.input;
    if (!input) return;
    mentionState.update(readDockMention(input.value, input.selectionStart, props.session.boxChoices()));
    syncInputActiveDescendant();
  };

  const openLog = (): void => {
    if (isLogOpenState.peek()) return;
    isLogOpenState.update(true);
    followLatestFn();
  };

  const openLogWhenTurnLive = (): void => {
    if (shouldOpenLogOnRefresh({
      isTurnOver: props.session.isTurnOver(),
      hasFailedOutbox: hasFailedOutboxEntry(props.session.outbox()),
      hasFailure: props.session.hasFailure(),
    })) {
      openLog();
    }
  };

  const foldLogWhenTurnOver = (): void => {
    if (shouldFoldLogOnBlur({
      isTurnOver: props.session.isTurnOver(),
      isAddressedTurnRunning: isAddressedTurnRunning(),
      hasFailedOutbox: hasFailedOutboxEntry(props.session.outbox()),
      hasFailure: props.session.hasFailure(),
    })) {
      isLogOpenState.update(false);
    }
  };

  const awaitPromptFor = (entryId: string): void => {
    if (entryIdsAwaitingPrompt.has(entryId)) return;
    entryIdsAwaitingPrompt.add(entryId);
    mainFeedRef?.whenCaughtUp(() => {
      outboxProjection.standInByEntryId.delete(entryId);
      entryIdsAwaitingPrompt.delete(entryId);
      paintQueue();
    });
  };

  const paintQueue = (): void => {
    const queueUpdate = reconcileDockQueue(
      queueState.peek(),
      outboxProjection,
      props.session.outbox(),
      props.session.isTurnOver(),
      clock.nowMs(),
    );
    for (const entryId of queueUpdate.removedStandInEntryIds) entryIdsAwaitingPrompt.delete(entryId);
    for (const entryId of queueUpdate.clearedStandInEntryIds) awaitPromptFor(entryId);
    queueState.update(queueUpdate.state);
    if (queueUpdate.shouldOpenLog) openLog();
    if (queueUpdate.shouldRefreshMainFeed) mainFeedRef?.refresh();
  };

  const openFeed = (sessionId: string, isBranch: boolean, workingDirectory: string | null, isTurnOver: () => boolean): ChatFeed => {
    const feed = createChatFeed({
      sessionId,
      workingDirectory,
      requestPage: (payload) => requestSessionTracePage(payload, TRACE_PAGE_TIMEOUT_MS),
      onPartsChanged: (changedParts, droppedPartIds, isLive) => {
        const update = applyPartsChanged(logState.peek(), sessionId, changedParts, droppedPartIds, isLive);
        logState.update(update.state);
        if (!isBranch && update.newLivePromptCount > 0) {
          const takenEntryIds = takeStandInsForPrompts(outboxProjection, update.newLivePromptCount);
          for (const entryId of takenEntryIds) {
            outboxProjection.standInByEntryId.delete(entryId);
            entryIdsAwaitingPrompt.delete(entryId);
          }
          if (takenEntryIds.length > 0) paintQueue();
        }
      },
      onRebuilt: (rebuiltParts, replacedPartIds) => {
        const distanceFromBottom = !isBranch && logElement ? logElement.scrollHeight - logElement.scrollTop : 0;
        logState.update((previous) => applySessionRebuilt(
          previous,
          sessionId,
          rebuiltParts,
          replacedPartIds,
          props.session.progressAnswers(),
        ));
        if (!isBranch) {
          queueMicrotask(() => {
            if (logElement) logElement.scrollTop = logElement.scrollHeight - distanceFromBottom;
          });
        }
      },
      onBeats: () => {},
      isTurnOver,
      onReset: () => {
        logState.update((previous) => applySessionReset(previous, sessionId));
      },
      onFailure: (text) => setFailureText(text),
    });
    feedBySessionId.set(sessionId, feed);
    return feed;
  };

  const handleCancelEntry = (entryId: string): void => {
    queueState.update((previous) => setCancellingEntry(previous, entryId, true));
    void chatCancelAction({ id: props.session.sessionId, entryId }).then((cancelOutcome) => {
      queueState.update((previous) => setCancellingEntry(previous, entryId, false));
      const decision = decideCancelReply(cancelOutcome);
      if (decision.failureText !== null) {
        setFailureText(decision.failureText);
        return;
      }
      if (decision.restoredText !== null && composerRef) {
        composerRef.restoreDraft(draftWithRestoredText(decision.restoredText, composerRef.readDraft()));
      }
    });
  };

  const sendToAgent = (targetId: string, text: string): Promise<string | null> => chatSendAction({
    id: targetId,
    text,
    attachments: [],
    isTurnRunning: isTargetSessionTurnRunning(
      props.session.sessionId,
      targetId,
      props.session.isTurnOver(),
      isBranchTurnOver,
    ),
  }).then((sendOutcome) => (sendOutcome.ok ? null : sendOutcome.error.message));

  const sendText = (text: string, sentAddress: DockAddress): Promise<string | null> => {
    const plan = planSendDispatch(sentAddress, props.session.sessionId, text);
    if (plan.kind === 'branch-spawn') {
      return branchSpawnAction({ id: plan.parentId, aboutBoxId: plan.aboutBoxId, prompt: plan.prompt })
        .then(decideBranchSpawnReply)
        .then((spawned) => {
          if (spawned.branchId === null) return spawned.failureText;
          props.session.onDelivered('branch');
          if (addressState.peek() === sentAddress) {
            setAddress({ kind: 'branch', sessionId: spawned.branchId, aboutTitle: plan.aboutTitle });
          }
          return null;
        });
    }
    if (plan.kind === 'branch-send') return sendToAgent(plan.sessionId, plan.text);

    const enqueued = enqueuePendingSend(queueState.peek(), plan.text);
    queueState.update(enqueued.state);
    paintQueue();
    const dispatchToMain = () => {
      queueState.update((previous) => markPendingSendDispatched(previous, enqueued.pendingId, props.session.outbox()));
      return sendToAgent(plan.sessionId, plan.text).then((sendFailure) => {
        queueState.update((previous) => markPendingSendOutcome(previous, enqueued.pendingId, sendFailure));
        if (sendFailure === null) props.session.onDelivered('talk');
        return sendFailure;
      });
    };
    const askProgress = () => (
      !plan.shouldAskProgress
        ? Promise.resolve(false)
        : studioProgressAskAction({ id: plan.sessionId, text: plan.text })
          .then((outcome) => outcome.ok && outcome.reply.type === 'studio-progress-ask-result' && outcome.reply.isAnswered)
    );
    const mainSend = mainSendQueue
      .then(askProgress)
      .then((isAnswered) => {
        if (!isAnswered) return dispatchToMain();
        props.session.onDelivered('progress');
        return null;
      })
      .finally(() => {
        queueState.update((previous) => settleDockPendingSend(previous, enqueued.pendingId));
        paintQueue();
      });
    mainSendQueue = mainSend.catch(() => null);
    return mainSend;
  };

  const paintActivity = (): void => {
    if (!activityRef) return;
    const { phase, beat } = props.session.activity();
    activityRef.setPhase(phase);
    if (beat !== null && beat !== shownActivityBeat) activityRef.beat([beat]);
    shownActivityBeat = beat;
  };

  const setBranches = (branches: readonly DockBranch[]): void => {
    branchTurnOverBySessionId.clear();
    for (const branch of branches) branchTurnOverBySessionId.set(branch.sessionId, branch.isTurnOver);
    const reconciled = reconcileDockBranches(
      logState.peek(),
      addressState.peek(),
      props.session.sessionId,
      new Set(feedBySessionId.keys()),
      branches,
    );
    logState.update(reconciled.logState);
    for (const sessionId of reconciled.sessionIdsToClose) {
      feedBySessionId.get(sessionId)?.close();
      feedBySessionId.delete(sessionId);
    }
    if (reconciled.nextAddress !== addressState.peek()) setAddress(reconciled.nextAddress);
    for (const branch of reconciled.branchesToOpen) {
      openFeed(branch.sessionId, true, branch.workingDirectory, branch.isTurnOver);
    }
  };

  const handle: DockHandle = {
    setBranches,
    addressSession: (sessionId, name) => {
      setAddress(resolveAddressForSession(props.session.sessionId, sessionId, name));
      composerRef?.input.focus();
    },
    addressBox: (boxId, title) => {
      setAddress(resolveAddressForBox(boxId, title));
      composerRef?.input.focus();
    },
    refresh: () => {
      openLogWhenTurnLive();
      paintComposer();
      paintQueue();
      paintActivity();
      for (const feed of feedBySessionId.values()) feed.refresh();
    },
    refreshDigests: () => {
      setDigestVersion((count) => count + 1);
      logState.update((previous) => setLogProgressAnswers(previous, props.session.progressAnswers()));
    },
    paintActivity,
    close: () => {
      if (dockLifecycle === 'closed') return;
      dockLifecycle = 'closed';
      cleanupResources();
    },
  };

  onSettled(() => {
    const session = props.session;
    const dock = dockElement;
    const log = logElement;
    const logContent = logContentElement;
    const jumpSlot = jumpSlotElement;
    if (!dock || !log || !logContent || !jumpSlot) return;

    const { jumpButton, followLatest } = stickToBottom(log, logContent);
    followLatestFn = followLatest;
    jumpSlot.replaceChildren(jumpButton);

    const activity = createChatActivity('plain');
    activityRef = activity;
    logContent.append(activity.element);

    const composer = createComposer(() => NO_UPLOADS_URL);
    composerRef = composer;
    composer.restoreDraft(chatDraftOf(session.sessionId));
    const pill = composer.element;
    pill.classList.add('bs-pill');
    pill.dataset.boardIsland = '';
    const input = composer.input;
    input.classList.add('bs-pill-input');
    input.placeholder = `Message ${session.name}, or @ a box to branch`;
    input.setAttribute('aria-label', `Message ${session.name}`);
    input.setAttribute('aria-autocomplete', 'list');
    if (addressChipElement) input.before(addressChipElement);
    dock.append(pill);

    const dockListeners = new AbortController();
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (isOutsideElement(dock, event.target)) foldLogWhenTurnOver();
      },
      { capture: true, signal: dockListeners.signal },
    );

    input.addEventListener('input', readMention, { signal: dockListeners.signal });
    input.addEventListener('blur', closeMentions, { signal: dockListeners.signal });
    input.addEventListener(
      'keydown',
      (event) => {
        const decision = decideMentionKeydown(mentionState.peek(), addressState.peek(), event.key, input.value.length);
        if (decision.kind === 'none') return;
        if (decision.kind === 'address-main') {
          if (decision.preventDefault) event.preventDefault();
          setAddress(MAIN_ADDRESS);
          return;
        }
        if (decision.kind === 'close-mentions') {
          event.preventDefault();
          event.stopImmediatePropagation();
          closeMentions();
          return;
        }
        if (decision.kind === 'step-mention') {
          event.preventDefault();
          mentionState.update(decision.nextState);
          syncInputActiveDescendant();
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        pickChoice(decision.choice);
      },
      { capture: true, signal: dockListeners.signal },
    );

    pill.addEventListener(
      'chat-draft',
      (event) => {
        const text = stringDetailOf(event, 'text');
        if (text === null) return;
        if (event instanceof CustomEvent && isImmediateDraftEvent(event.detail)) {
          saveChatDraft(session.sessionId, text);
          return;
        }
        scheduleChatDraftSave(session.sessionId, text);
      },
      { signal: dockListeners.signal },
    );

    pill.addEventListener(
      'chat-send',
      (event) => {
        const text = stringDetailOf(event, 'text');
        if (text === null || text.length === 0) return;
        closeMentions();
        const sentAddress = addressState.peek();
        followLatest();
        const restoreText = (sendFailure: string) => {
          if (input.value.trim().length === 0) composer.restoreDraft(text);
          setFailureText(sendFailure);
        };
        sendText(text, sentAddress)
          .then((sendFailure) => {
            if (sendFailure === null) {
              setFailureText(null);
              return;
            }
            restoreText(sendFailure);
          })
          .catch((reason: unknown) => restoreText(`Could not confirm the message was queued: ${errorMessage(reason)}`));
      },
      { signal: dockListeners.signal },
    );

    pill.addEventListener(
      'chat-stop',
      () => {
        const sessionId = addressedSessionIdOf(addressState.peek(), session.sessionId);
        if (sessionId !== null) void chatStopAction({ id: sessionId });
      },
      { signal: dockListeners.signal },
    );

    const modelPicker = listenForModelChange({
      root: pill,
      sessionId: session.sessionId,
      canOpen: session.isTurnOver,
      showFailure: (text) => setFailureText(text),
      signal: dockListeners.signal,
    });

    const stopFollowingOutbox = watchChatOutbox(session.sessionId, () => {
      queueState.update((previous) => reconcileOutboxEcho(previous, session.outbox()));
      paintQueue();
    });

    const stopFollowingBoardChanges = onAgentChange((_sessionId, boardChange) => {
      if (boardChange.boardId === session.mapBoardId()) setBoardChangeVersion((count) => count + 1);
    });

    const mainFeed = openFeed(session.sessionId, false, session.workingDirectory, session.isTurnOver);
    mainFeedRef = mainFeed;
    mainFeed.whenCaughtUp(followLatest);

    openLogWhenTurnLive();
    paintComposer();
    paintQueue();
    paintActivity();
    const railTimer = setInterval(paintComposer, RAIL_TICK_MS);

    cleanupResources = () => {
      if (sessionUIs.has(session.sessionId)) saveChatDraft(session.sessionId, composer.readDraft());
      stopFollowingOutbox();
      stopFollowingBoardChanges();
      modelPicker.close();
      dockListeners.abort();
      clearInterval(railTimer);
      for (const feed of feedBySessionId.values()) feed.close();
      feedBySessionId.clear();
      mainFeedRef = null;
      pill.remove();
      activity.element.remove();
      jumpSlot.replaceChildren();
    };

    props.onHandle(handle);

    return () => {
      handle.close();
    };
  });

  onCleanup(() => {
    handle.close();
  });

  return (
    <section
      ref={(element) => { dockElement = element; }}
      class="bs-dock"
      aria-label="Chat"
      data-log-open={isLogOpenState.read() ? 'true' : undefined}
      onFocusIn={() => openLog()}
      onFocusOut={(event) => {
        if (isOutsideElement(dockElement, event.relatedTarget)) foldLogWhenTurnOver();
      }}
    >
      <div class="bs-log-frame">
        <div
          ref={(element) => { logElement = element; }}
          class="bs-log"
          role="log"
          onScroll={() => {
            if (logElement && logElement.scrollTop <= NEAR_TOP_PX) mainFeedRef?.loadEarlier();
          }}
        >
          <div ref={(element) => { logContentElement = element; }} class="bs-log-content">
            <div class="bs-log-rows">
              <For each={mergedLogRows()} keyed={(row) => row.key}>
                {(rowAccessor) => {
                  const row = rowAccessor;
                  return (
                    <Show
                      when={row().kind === 'part' ? (row() as PartRowEntry<DockBranch>) : undefined}
                      fallback={
                        <Show
                          when={row().kind === 'progress-question'}
                          fallback={
                            <div class="bs-row bs-row-agent bs-row-glimmervoid" data-at={String(row().at ?? '')}>
                              <div class="bs-bubble bs-bubble-agent">
                                <span class="bs-bubble-who">{GLIMMERVOID_NAME}</span>
                                <p class="bs-digest">{(row() as ProgressAnswerRowEntry).answer}</p>
                              </div>
                            </div>
                          }
                        >
                          <div class="bs-row bs-row-you" data-at={String(row().at ?? '')}>
                            <div
                              class="bs-bubble bs-bubble-you"
                              ref={markdownDirective(() => (row() as ProgressQuestionRowEntry).question)}
                            />
                          </div>
                        </Show>
                      }
                    >
                      {(partRow) => {
                        const partKind = createMemo(() => partRow().part.kind);
                        const turnDisplay = createMemo(() => {
                          digestVersion();
                          return selectTurnDisplay(partRow(), attributionBySessionId(), props.session.digestOf);
                        });
                        const isExpanded = createMemo(() => expandedRowKeys().has(partRow().key));
                        let bubbleElement: HTMLDivElement | undefined;

                        return (
                          <>
                            <Show when={partKind() === 'prompt'}>
                              <div
                                class={partRow().speaker.branch ? 'bs-row bs-row-you bs-row-branch' : 'bs-row bs-row-you'}
                                data-part-id={partRow().part.id}
                                data-session-id={partRow().sessionId}
                                data-board-change-at=""
                                data-at={partRow().at !== null ? String(partRow().at) : undefined}
                                hidden={(partRow().part as Extract<ChatPart, { kind: 'prompt' }>).isBoardAnswer}
                              >
                                <div class="bs-bubble bs-bubble-you">
                                  <Show when={partRow().speaker.branch}>
                                    {(branch) => <span class="bs-bubble-who">{`To ${branch().aboutTitle}`}</span>}
                                  </Show>
                                  <div
                                    ref={markdownDirective(() => {
                                      const current = partRow();
                                      const promptPart = current.part as Extract<ChatPart, { kind: 'prompt' }>;
                                      return current.speaker.branch ? operatorPartOfPrompt(promptPart.text) : promptPart.text;
                                    })}
                                  />
                                </div>
                              </div>
                            </Show>

                            <Show when={partKind() === 'turn'}>
                              <Show
                                when={turnDisplay().shown}
                                fallback={
                                  <div
                                    class="bs-row bs-row-agent"
                                    data-part-id={partRow().part.id}
                                    data-session-id={partRow().sessionId}
                                    data-board-change-at={String(turnDisplay().boardChange?.at ?? '')}
                                    data-at={partRow().at !== null ? String(partRow().at) : undefined}
                                    hidden={true}
                                  />
                                }
                              >
                                {(shown) => (
                                  <div
                                    class={partRow().speaker.branch ? 'bs-row bs-row-agent bs-row-branch' : 'bs-row bs-row-agent'}
                                    data-part-id={partRow().part.id}
                                    data-session-id={partRow().sessionId}
                                    data-board-change-at={String(turnDisplay().boardChange?.at ?? '')}
                                    data-at={partRow().at !== null ? String(partRow().at) : undefined}
                                    data-digest={shown().text}
                                    data-expanded={String(isExpanded())}
                                  >
                                    <span
                                      class={partRow().speaker.branch ? 'bs-face bs-face-branch' : 'bs-face'}
                                      ref={[
                                        agentMarkDirective(() => ({
                                          agentId: partRow().speaker.agentId,
                                          name: partRow().speaker.name,
                                        })),
                                        (element) => {
                                          const initialBranch = partRow().speaker.branch;
                                          if (initialBranch !== null) {
                                            bindPressableElement(element, `Reply to ${initialBranch.name}`, () => {
                                              const latestBranch = partRow().speaker.branch;
                                              if (latestBranch !== null) {
                                                setAddress(resolveAddressForBranch(latestBranch));
                                                composerRef?.input.focus();
                                              }
                                            });
                                          }
                                        },
                                      ]}
                                    />
                                    <div
                                      class="bs-bubble bs-bubble-agent"
                                      ref={[
                                        ariaExpandedDirective(() => isExpanded()),
                                        (element) => {
                                          bubbleElement = element;
                                          bindPressableElement(element, `Whole reply from ${partRow().speaker.name}`, () => {
                                            setExpandedRowKeys((previous) => toggleExpandedRowKey(previous, partRow().key));
                                            queueMicrotask(() => {
                                              bubbleElement?.focus();
                                            });
                                          });
                                        },
                                      ]}
                                    >
                                      <span class="bs-bubble-who">{partRow().speaker.name}</span>
                                      <div class="bs-bubble-body">
                                        <Show
                                          when={shown().kind === 'chat-line'}
                                          fallback={
                                            <div
                                              class="bs-digest bs-last-reply"
                                              ref={markdownDirective(() => shown().text)}
                                            />
                                          }
                                        >
                                          <p class="bs-digest">{shown().text}</p>
                                        </Show>
                                        <Show when={isExpanded()}>
                                          <div
                                            class="bs-full-reply"
                                            ref={fullReplyDirective(() => partRow().part as Extract<ChatPart, { kind: 'turn' }>)}
                                          />
                                        </Show>
                                        <Show when={turnDisplay().boardChange}>
                                          {(boardChange) => (
                                            <div class="bs-reply-actions">
                                              <Button
                                                variant="primary"
                                                size="small"
                                                textCase="inline"
                                                label="Show on board"
                                                onClick={() => props.session.showBoardChange(partRow().sessionId, boardChange())}
                                              />
                                            </div>
                                          )}
                                        </Show>
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </Show>
                            </Show>

                            <Show when={partKind() === 'card' ? (partRow().part as Extract<ChatPart, { kind: 'card' }>) : undefined}>
                              {(cardPart) => {
                                const renderedCard = createMemo(() => renderStudioCard(cardPart().card));
                                return (
                                  <Show when={renderedCard()}>
                                    {(cardNode) => (
                                      <div
                                        class="bs-row bs-row-card"
                                        data-part-id={partRow().part.id}
                                        data-session-id={partRow().sessionId}
                                        data-board-change-at=""
                                        ref={cardNodeDirective(() => cardNode())}
                                      />
                                    )}
                                  </Show>
                                );
                              }}
                            </Show>
                          </>
                        );
                      }}
                    </Show>
                  );
                }}
              </For>
            </div>

            <div class="bs-log-queue">
              <For each={queueState.read().queueView.standInPrompts} keyed={(standIn) => standIn.id}>
                {(standIn) => (
                  <div class="bs-row bs-row-you" hidden={standIn().isBoardAnswer}>
                    <div
                      class="bs-bubble bs-bubble-you"
                      ref={markdownDirective(() => standIn().text)}
                    />
                  </div>
                )}
              </For>
              <For each={queueState.read().queueView.queuedEntries} keyed={(entry) => entry.entryId}>
                {(entry) => (
                  <div class="bs-row bs-row-you bs-row-queued" data-state={entry().state}>
                    <div class="bs-queued-meta">
                      <span class="bs-queued-status">{studioQueuedStatusOf(entry())}</span>
                      <Button
                        variant="quiet"
                        size="small"
                        textCase="inline"
                        label="Cancel"
                        disabled={isOutboxCancelDisabled(entry(), queueState.read().cancellingEntryIds)}
                        onClick={() => handleCancelEntry(entry().entryId)}
                      />
                    </div>
                    <div
                      class="bs-bubble bs-bubble-you"
                      ref={markdownDirective(() => entry().text)}
                    />
                  </div>
                )}
              </For>
              <For each={queueState.read().queueView.pendingSends} keyed={false}>
                {(pending) => (
                  <div class="bs-row bs-row-you bs-row-queued" data-state="pending">
                    <div class="bs-queued-meta">
                      <span class="bs-queued-status">{pending().statusText}</span>
                      <Button
                        variant="quiet"
                        size="small"
                        textCase="inline"
                        label="Cancel"
                        disabled={true}
                      />
                    </div>
                    <div
                      class="bs-bubble bs-bubble-you"
                      ref={markdownDirective(() => pending().text)}
                    />
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
        <div ref={(element) => { jumpSlotElement = element; }} class="bs-jump-slot" />
      </div>

      <p class="bs-failure" role="status" hidden={failureText() === null}>
        {failureText() ?? ''}
      </p>

      <div
        class="bs-mentions"
        role="listbox"
        aria-label="Boxes"
        hidden={mentionItems().length === 0}
      >
        <For each={mentionItems()}>
          {(entry) => (
            <>
              <Show when={entry.showGroupLabel}>
                <div class="bs-mention-group" role="presentation">{entry.choice.repoName}</div>
              </Show>
              <Pressable
                class="bs-mention"
                text={entry.choice.title}
                id={`bs-mention-${entry.index}`}
                role="option"
                aria-selected={entry.index === mentionState.read().activeIndex ? 'true' : 'false'}
                data-box-id={entry.choice.boxId}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => pickChoice(entry.choice)}
              />
            </>
          )}
        </For>
      </div>

      <span
        ref={(element) => { addressChipElement = element; }}
        class="bs-pill-address"
        hidden={addressState.read().kind === 'main'}
      >
        <span class="bs-pill-address-text">{addressLabel()}</span>
        <Pressable
          class="bs-pill-address-clear"
          data-action="board-session-address-main"
          ref={(element) => {
            labelIconPressable(element, `Message ${props.session.name}`);
            element.replaceChildren(createLineIcon(CLEAR_ICON_PATH, '1.6'));
          }}
          onClick={() => {
            setAddress(MAIN_ADDRESS);
            composerRef?.input.focus();
          }}
        />
      </span>
    </section>
  );
}

export function mountDockIsland(host: HTMLElement, lifecycleHost: HTMLElement, session: DockSession): DockHandle {
  let activeHandle: DockHandle | null = null;
  let queuedBranches: readonly DockBranch[] | null = null;
  let pendingAddressSession: { sessionId: string | null; name: string } | null = null;
  let pendingAddressBox: { boxId: string; title: string } | null = null;
  let mountLifecycle: 'mounted' | 'disposed' = 'mounted';

  const disposeIsland = mountIsland(
    host,
    () => (
      <Dock
        session={session}
        onHandle={(readyHandle) => {
          activeHandle = readyHandle;
          if (queuedBranches !== null) {
            readyHandle.setBranches(queuedBranches);
            queuedBranches = null;
          }
          if (pendingAddressSession !== null) {
            readyHandle.addressSession(pendingAddressSession.sessionId, pendingAddressSession.name);
            pendingAddressSession = null;
          }
          if (pendingAddressBox !== null) {
            readyHandle.addressBox(pendingAddressBox.boxId, pendingAddressBox.title);
            pendingAddressBox = null;
          }
        }}
      />
    ),
    { lifecycleHost },
  );

  return {
    setBranches(branches) {
      if (mountLifecycle === 'disposed') return;
      if (activeHandle) {
        activeHandle.setBranches(branches);
        return;
      }
      queuedBranches = branches;
    },
    addressSession(sessionId, name) {
      if (mountLifecycle === 'disposed') return;
      if (activeHandle) {
        activeHandle.addressSession(sessionId, name);
        return;
      }
      pendingAddressSession = { sessionId, name };
      pendingAddressBox = null;
    },
    addressBox(boxId, title) {
      if (mountLifecycle === 'disposed') return;
      if (activeHandle) {
        activeHandle.addressBox(boxId, title);
        return;
      }
      pendingAddressBox = { boxId, title };
      pendingAddressSession = null;
    },
    refresh() {
      if (mountLifecycle !== 'disposed') activeHandle?.refresh();
    },
    refreshDigests() {
      if (mountLifecycle !== 'disposed') activeHandle?.refreshDigests();
    },
    paintActivity() {
      if (mountLifecycle !== 'disposed') activeHandle?.paintActivity();
    },
    close() {
      if (mountLifecycle === 'disposed') return;
      mountLifecycle = 'disposed';
      activeHandle?.close();
      disposeIsland();
      host.replaceChildren();
    },
  };
}
