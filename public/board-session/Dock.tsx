import { For, Show, createEffect, createMemo, createSignal, onCleanup, onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { operatorPartOfPrompt } from '#shared/board-branch-core.ts';
import { clock } from '#shared/clock.ts';
import { BRANCH_PROMPT_MAX_CHARS, PROGRESS_QUESTION_MAX_CHARS } from '#shared/contracts/control/board-session-messages.ts';
import { CHAT_SEND_MAX_CHARS } from '#shared/contracts/control/session-messages.ts';
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
  isOptimisticOutboxEntryId,
  reconcileChatOutboxProjection,
  takeStandInsForPrompts,
} from '../state/chat-outbox-core.ts';
import { watchChatOutbox } from '../state/collections/chat-outbox.ts';
import { requestSessionTracePage } from '../state/collections/sessions.ts';
import { createLineIcon } from '../svg-dom.ts';
import { Button } from '../ui/Button.tsx';
import { mountIsland } from '../ui/island.ts';
import { Pressable } from '../ui/Pressable.tsx';
import { labelIconPressable } from '../ui/pressable.ts';
import { onAgentChange } from '../whiteboard/board-tile-store.ts';
import type { AgentChip } from '../whiteboard/board-tile-store.ts';
import {
  addressLabelOf,
  boxMentionAt,
  matchingBoxChoices,
  placeTitleOf,
  textWithoutMention,
} from './branch-core.ts';
import type { BoxChoice, BoxMention, DockAddress } from './branch-core.ts';
import {
  addressedSessionIdOf,
  claimPendingSends,
  computeSessionTurnAttribution,
  groupMentionChoices,
  insertProgressAnswersByTime,
  partTimeOf,
  progressAnswerRowsList,
  replyTextsOf,
  shouldFoldLogOnBlur,
  shouldOpenLogOnRefresh,
  shownTextOfTurn,
  stepMentionIndex,
} from './dock-core.ts';
import type { PendingSend, TurnShownText, TurnStart } from './dock-core.ts';

const TRACE_PAGE_TIMEOUT_MS = 10_000;
const GLIMMERVOID_NAME = 'Glimmervoid';
const NEAR_TOP_PX = 48;
const CLEAR_ICON_PATH = 'M4 4l8 8M12 4l-8 8';
const NOT_SENT_TEXT = 'The message was not sent.';
const MAIN_ADDRESS: DockAddress = { kind: 'main' };
const RAIL_TICK_MS = 30_000;
const NO_UPLOADS_URL = '';
const PENDING_RUNNING_STATUS_TEXT = 'Queued';
const PENDING_IDLE_STATUS_TEXT = 'Sending';
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

export interface DockBranch {
  sessionId: string;
  name: string;
  workingDirectory: string | null;
  agentId: string | null;
  aboutTitle: string;
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

interface FeedSpeaker {
  sessionId: string;
  name: string;
  agentId: string | null;
  branch: DockBranch | null;
}

interface PartRowEntry {
  kind: 'part';
  key: string;
  sessionId: string;
  part: ChatPart;
  speaker: FeedSpeaker;
  at: number | null;
}

interface ProgressQuestionRowEntry {
  kind: 'progress-question';
  key: string;
  question: string;
  at: number;
}

interface ProgressAnswerRowEntry {
  kind: 'progress-answer';
  key: string;
  answer: string;
  at: number;
}

type LogRowEntry = PartRowEntry | ProgressQuestionRowEntry | ProgressAnswerRowEntry;

interface QueueDisplayState {
  standInPrompts: Extract<ChatPart, { kind: 'prompt' }>[];
  queuedEntries: ChatOutboxEntry[];
  pendingSends: { text: string; statusText: string }[];
}

function isInsideFullReply(eventTarget: EventTarget | null): boolean {
  return eventTarget instanceof Element && eventTarget.closest('.bs-full-reply, .bs-reply-actions') !== null;
}

function isOutsideElement(container: HTMLElement | undefined, target: EventTarget | null): boolean {
  return container !== undefined && target instanceof Node && !container.contains(target);
}

function requestBranchSpawn(
  parentId: string,
  aboutBoxId: string,
  prompt: string,
): Promise<{ branchId: string | null; failureText: string }> {
  return branchSpawnAction({ id: parentId, aboutBoxId, prompt }).then((outcome) => {
    if (!outcome.ok) return { branchId: null, failureText: outcome.error.message || NOT_SENT_TEXT };
    if (outcome.reply.type !== 'branch-spawn-result' || outcome.reply.branchId === null) {
      return { branchId: null, failureText: NOT_SENT_TEXT };
    }
    return { branchId: outcome.reply.branchId, failureText: '' };
  });
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

  const [isLogOpen, setIsLogOpen] = createSignal(false);
  const [failureText, setFailureText] = createSignal<string | null>(null);
  const [address, setAddressSignal] = createSignal<DockAddress>(MAIN_ADDRESS);
  const [mentionChoices, setMentionChoices] = createSignal<BoxChoice[]>([]);
  const [activeChoiceIndex, setActiveChoiceIndex] = createSignal(0);
  const [partEntries, setPartEntries] = createSignal<PartRowEntry[]>([]);
  const [progressAnswers, setProgressAnswers] = createSignal<readonly SessionProgressAnswer[]>([]);
  const [expandedRowKeys, setExpandedRowKeys] = createSignal<ReadonlySet<string>>(new Set());
  const [digestVersion, setDigestVersion] = createSignal(0);
  const [boardChangeVersion, setBoardChangeVersion] = createSignal(0);
  const [queueView, setQueueView] = createSignal<QueueDisplayState>({
    standInPrompts: [],
    queuedEntries: [],
    pendingSends: [],
  });
  const [cancellingEntryIds, setCancellingEntryIds] = createSignal<ReadonlySet<string>>(new Set());

  const mentionItems = createMemo(() => groupMentionChoices(mentionChoices()));
  const addressLabel = createMemo(() => addressLabelOf(address()));

  const feedBySessionId = new Map<string, ChatFeed>();
  const speakerBySessionId = new Map<string, FeedSpeaker>();
  const branchTurnOverBySessionId = new Map<string, () => boolean>();
  const turnStartsBySessionId = new Map<string, Map<string, TurnStart>>();
  const shownPromptPartIds = new Set<string>();
  const entryIdsAwaitingPrompt = new Set<string>();
  const outboxProjection = createChatOutboxProjection();

  let currentAddress: DockAddress = MAIN_ADDRESS;
  let currentMention: BoxMention | null = null;
  let currentMentionChoices: BoxChoice[] = [];
  let currentActiveChoiceIndex = 0;
  let pendingSends: PendingSend[] = [];
  let mainSendQueue: Promise<string | null> = Promise.resolve(null);
  let shownActivityBeat: ActivityBeat | null = null;
  let dockLifecycle: 'open' | 'closed' = 'open';
  let composerRef: ReturnType<typeof createComposer> | null = null;
  let activityRef: ReturnType<typeof createChatActivity> | null = null;
  let followLatestFn: () => void = () => {};
  let mainFeedRef: ChatFeed | null = null;
  let cleanupResources: () => void = () => {};

  const rowKeyOf = (sessionId: string, partId: string) => `${sessionId}:${partId}`;

  const turnStartsOf = (sessionId: string): TurnStart[] => [...(turnStartsBySessionId.get(sessionId)?.values() ?? [])];

  const noteTurnStart = (sessionId: string, part: ChatPart): void => {
    if (part.kind !== 'prompt' && part.kind !== 'system-line') return;
    const turnStarts = turnStartsBySessionId.get(sessionId) ?? new Map<string, TurnStart>();
    turnStarts.set(part.id, { at: part.at, isRelayNews: part.kind === 'system-line' && part.isRelayNews });
    turnStartsBySessionId.set(sessionId, turnStarts);
  };

  const forgetTurnStarts = (sessionId: string): void => {
    turnStartsBySessionId.delete(sessionId);
  };

  const attributionBySessionId = createMemo(() => {
    boardChangeVersion();
    const mapBoardId = props.session.mapBoardId();
    const entries = partEntries();
    const turnsBySession = new Map<string, { id: string; openedAt: number | null }[]>();
    for (const entry of entries) {
      if (entry.part.kind !== 'turn') continue;
      const list = turnsBySession.get(entry.sessionId) ?? [];
      list.push({ id: entry.part.id, openedAt: entry.part.openedAt });
      turnsBySession.set(entry.sessionId, list);
    }
    const attributions = new Map<string, ReturnType<typeof computeSessionTurnAttribution<AgentChip>>>();
    for (const [sessionId, turns] of turnsBySession) {
      attributions.set(
        sessionId,
        computeSessionTurnAttribution(
          turns,
          turnStartsOf(sessionId),
          boardChangesBySessionId.get(sessionId) ?? [],
          mapBoardId,
        ),
      );
    }
    return attributions;
  });

  const mergedLogRows = createMemo<LogRowEntry[]>(() => {
    const uniqueAnswers = progressAnswerRowsList(progressAnswers());
    const answerRows = uniqueAnswers.flatMap((entry) => [
      {
        askedAt: entry.askedAt,
        row: {
          kind: 'progress-question' as const,
          key: `progress-q:${entry.askedAt}`,
          question: entry.question,
          at: entry.askedAt,
        },
      },
      {
        askedAt: entry.askedAt,
        row: {
          kind: 'progress-answer' as const,
          key: `progress-a:${entry.askedAt}`,
          answer: entry.answer,
          at: entry.askedAt,
        },
      },
    ]);
    return insertProgressAnswersByTime<LogRowEntry>(partEntries(), answerRows);
  });

  const syncInputActiveDescendant = (): void => {
    const input = composerRef?.input;
    if (!input) return;
    if (currentMentionChoices.length === 0) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    input.setAttribute('aria-activedescendant', `bs-mention-${currentActiveChoiceIndex}`);
  };

  const closeMentions = (): void => {
    currentMention = null;
    currentMentionChoices = [];
    currentActiveChoiceIndex = 0;
    setMentionChoices([]);
    setActiveChoiceIndex(0);
    syncInputActiveDescendant();
  };

  const isTargetTurnRunning = (targetId: string): boolean => (
    targetId === props.session.sessionId
      ? !props.session.isTurnOver()
      : !(branchTurnOverBySessionId.get(targetId)?.() ?? true)
  );

  const isAddressedTurnRunning = (): boolean => {
    const sessionId = addressedSessionIdOf(currentAddress, props.session.sessionId);
    if (sessionId === null) return false;
    if (sessionId === props.session.sessionId) return !props.session.isTurnOver();
    return feedBySessionId.has(sessionId) && !(branchTurnOverBySessionId.get(sessionId)?.() ?? true);
  };

  const paintComposer = (): void => {
    if (!composerRef) return;
    composerRef.setTurnRunning(isAddressedTurnRunning());
    composerRef.showRail(props.session.railFields(canSwitchSessionModel(props.session.sessionId) && props.session.isTurnOver()));
  };

  const setAddress = (nextAddress: DockAddress): void => {
    currentAddress = nextAddress;
    setAddressSignal(nextAddress);
    if (composerRef) {
      composerRef.input.maxLength = nextAddress.kind === 'new-branch' ? BRANCH_PROMPT_MAX_CHARS : CHAT_SEND_MAX_CHARS;
    }
    paintComposer();
  };

  const addressBranch = (branch: DockBranch): void => {
    setAddress({ kind: 'branch', sessionId: branch.sessionId, aboutTitle: branch.aboutTitle });
    composerRef?.input.focus();
  };

  const pickChoice = (choice: BoxChoice): void => {
    if (currentMention === null || !composerRef) return;
    composerRef.input.value = textWithoutMention(composerRef.input.value, currentMention);
    closeMentions();
    setAddress({ kind: 'new-branch', aboutBoxId: choice.boxId, aboutTitle: placeTitleOf(choice.repoName, choice.title) });
    composerRef.restoreDraft(composerRef.input.value);
    composerRef.input.focus();
  };

  const readMention = (): void => {
    const input = composerRef?.input;
    if (!input) return;
    currentMention = boxMentionAt(input.value, input.selectionStart ?? input.value.length);
    if (currentMention === null) {
      closeMentions();
      return;
    }
    currentMentionChoices = matchingBoxChoices(props.session.boxChoices(), currentMention.query);
    currentActiveChoiceIndex = 0;
    setMentionChoices(currentMentionChoices);
    setActiveChoiceIndex(0);
    syncInputActiveDescendant();
  };

  const openLog = (): void => {
    if (isLogOpen()) return;
    setIsLogOpen(true);
    followLatestFn();
  };

  const hasFailedOutbox = (): boolean => props.session.outbox().some((entry) => entry.state === 'failed');

  const openLogWhenTurnLive = (): void => {
    if (shouldOpenLogOnRefresh({
      isTurnOver: props.session.isTurnOver(),
      hasFailedOutbox: hasFailedOutbox(),
      hasFailure: props.session.hasFailure(),
    })) {
      openLog();
    }
  };

  const foldLogWhenTurnOver = (): void => {
    if (shouldFoldLogOnBlur({
      isTurnOver: props.session.isTurnOver(),
      isAddressedTurnRunning: isAddressedTurnRunning(),
      hasFailedOutbox: hasFailedOutbox(),
      hasFailure: props.session.hasFailure(),
    })) {
      setIsLogOpen(false);
    }
  };

  const removeStandIns = (entryIds: readonly string[]): void => {
    for (const entryId of entryIds) {
      outboxProjection.standInByEntryId.delete(entryId);
      entryIdsAwaitingPrompt.delete(entryId);
    }
  };

  const awaitPromptFor = (entryId: string): void => {
    if (entryIdsAwaitingPrompt.has(entryId)) return;
    entryIdsAwaitingPrompt.add(entryId);
    mainFeedRef?.whenCaughtUp(() => {
      removeStandIns([entryId]);
      paintQueue();
    });
  };

  const paintQueue = (): void => {
    const entries = props.session.outbox();
    const update = reconcileChatOutboxProjection(outboxProjection, entries, !props.session.isTurnOver(), clock.nowMs());
    removeStandIns(update.removedStandInEntryIds);
    for (const entryId of update.clearedStandInEntryIds) awaitPromptFor(entryId);
    claimPendingSends(pendingSends, entries);
    const shownPendingSends = pendingSends
      .filter((pending) => !pending.isClaimed)
      .map((pending) => ({
        text: pending.text,
        statusText: props.session.isTurnOver() ? PENDING_IDLE_STATUS_TEXT : PENDING_RUNNING_STATUS_TEXT,
      }));
    const standInPrompts = [...outboxProjection.standInByEntryId.values()].filter(
      (standIn): standIn is Extract<ChatPart, { kind: 'prompt' }> => standIn.kind === 'prompt',
    );
    setQueueView({
      standInPrompts,
      queuedEntries: update.queuedEntries,
      pendingSends: shownPendingSends,
    });
    if (update.queuedEntries.some((entry) => entry.state === 'failed')) openLog();
    if (update.clearedStandInEntryIds.length > 0) mainFeedRef?.refresh();
  };

  const takeRecordedPrompts = (changedParts: readonly ChatPart[], droppedPartIds: readonly string[], isLive: boolean): void => {
    for (const droppedPartId of droppedPartIds) shownPromptPartIds.delete(droppedPartId);
    const newPromptParts = changedParts.filter(
      (part) => part.kind === 'prompt' && !part.isBoardAnswer && !shownPromptPartIds.has(part.id),
    );
    for (const promptPart of newPromptParts) shownPromptPartIds.add(promptPart.id);
    if (!isLive) return;
    const takenEntryIds = takeStandInsForPrompts(outboxProjection, newPromptParts.length);
    removeStandIns(takenEntryIds);
    if (takenEntryIds.length > 0) paintQueue();
  };

  const upsertParts = (sessionId: string, parts: readonly ChatPart[]): void => {
    const speaker = speakerBySessionId.get(sessionId);
    if (!speaker || parts.length === 0) return;
    for (const part of parts) noteTurnStart(sessionId, part);
    setPartEntries((previous) => {
      const next = [...previous];
      const indexByKey = new Map(next.map((entry, index) => [entry.key, index]));
      for (const part of parts) {
        const key = rowKeyOf(sessionId, part.id);
        const existingIndex = indexByKey.get(key);
        if (part.kind !== 'prompt' && part.kind !== 'turn' && part.kind !== 'card') {
          if (existingIndex !== undefined) {
            next.splice(existingIndex, 1);
            indexByKey.clear();
            for (let i = 0; i < next.length; i += 1) indexByKey.set(next[i].key, i);
          }
          continue;
        }
        const entry: PartRowEntry = {
          kind: 'part',
          key,
          sessionId,
          part,
          speaker,
          at: partTimeOf(part),
        };
        if (existingIndex !== undefined) {
          next[existingIndex] = entry;
          continue;
        }
        indexByKey.set(key, next.length);
        next.push(entry);
      }
      return next;
    });
  };

  const removeParts = (sessionId: string, partIds: readonly string[]): void => {
    if (partIds.length === 0) return;
    const removedKeys = new Set<string>();
    for (const partId of partIds) {
      turnStartsBySessionId.get(sessionId)?.delete(partId);
      removedKeys.add(rowKeyOf(sessionId, partId));
    }
    setPartEntries((previous) => previous.filter((entry) => !removedKeys.has(entry.key)));
  };

  const removeSessionRows = (sessionId: string): void => {
    setPartEntries((previous) => previous.filter((entry) => entry.sessionId !== sessionId));
  };

  const openFeed = (speaker: FeedSpeaker, workingDirectory: string | null, isTurnOver: () => boolean): ChatFeed => {
    const sessionId = speaker.sessionId;
    speakerBySessionId.set(sessionId, speaker);
    const feed = createChatFeed({
      sessionId,
      workingDirectory,
      requestPage: (payload) => requestSessionTracePage(payload, TRACE_PAGE_TIMEOUT_MS),
      onPartsChanged: (changedParts, droppedPartIds, isLive) => {
        if (!speaker.branch) takeRecordedPrompts(changedParts, droppedPartIds, isLive);
        upsertParts(sessionId, changedParts);
        removeParts(sessionId, droppedPartIds);
      },
      onRebuilt: (rebuiltParts, replacedPartIds) => {
        forgetTurnStarts(sessionId);
        if (speaker.branch) {
          removeParts(sessionId, replacedPartIds);
          removeSessionRows(sessionId);
          upsertParts(sessionId, rebuiltParts);
          return;
        }
        const distanceFromBottom = logElement ? logElement.scrollHeight - logElement.scrollTop : 0;
        removeParts(sessionId, replacedPartIds);
        setPartEntries([]);
        shownPromptPartIds.clear();
        for (const part of rebuiltParts) {
          if (part.kind === 'prompt') shownPromptPartIds.add(part.id);
        }
        upsertParts(sessionId, rebuiltParts);
        setProgressAnswers([...props.session.progressAnswers()]);
        queueMicrotask(() => {
          if (logElement) logElement.scrollTop = logElement.scrollHeight - distanceFromBottom;
        });
      },
      onBeats: () => {},
      isTurnOver,
      onReset: () => {
        forgetTurnStarts(sessionId);
        if (!speaker.branch) shownPromptPartIds.clear();
        removeSessionRows(sessionId);
      },
      onFailure: (text) => setFailureText(text),
    });
    feedBySessionId.set(sessionId, feed);
    return feed;
  };

  const restoreToBar = (text: string): void => {
    if (!composerRef) return;
    composerRef.restoreDraft(draftWithRestoredText(text, composerRef.readDraft()));
  };

  const handleCancelEntry = (entryId: string): void => {
    setCancellingEntryIds((previous) => new Set([...previous, entryId]));
    void chatCancelAction({ id: props.session.sessionId, entryId }).then((cancelOutcome) => {
      setCancellingEntryIds((previous) => {
        const next = new Set(previous);
        next.delete(entryId);
        return next;
      });
      if (!cancelOutcome.ok) {
        setFailureText(`Could not cancel the message: ${cancelOutcome.error.message}`);
        return;
      }
      if (cancelOutcome.reply.type !== 'chat-cancel-result' || cancelOutcome.reply.cancelledTexts.length === 0) return;
      restoreToBar(cancelOutcome.reply.cancelledTexts.join('\n\n'));
    });
  };

  const dropPendingSend = (pending: PendingSend): void => {
    pendingSends = pendingSends.filter((candidate) => candidate !== pending);
    paintQueue();
  };

  const settlePendingSend = (pending: PendingSend): void => {
    if (pending.isAwaitingOutboxEcho && !pending.isClaimed) return;
    dropPendingSend(pending);
  };

  const sendToAgent = (targetId: string, text: string): Promise<string | null> => chatSendAction({
    id: targetId,
    text,
    attachments: [],
    isTurnRunning: isTargetTurnRunning(targetId),
  }).then((sendOutcome) => (sendOutcome.ok ? null : sendOutcome.error.message));

  const deliveredAs = (kind: DockDelivery, sending: Promise<string | null>): Promise<string | null> => sending.then((sendFailure) => {
    if (sendFailure === null) props.session.onDelivered(kind);
    return sendFailure;
  });

  const sendText = (text: string, sentAddress: DockAddress): Promise<string | null> => {
    if (sentAddress.kind === 'new-branch') {
      return requestBranchSpawn(props.session.sessionId, sentAddress.aboutBoxId, text).then((spawned) => {
        if (spawned.branchId === null) return spawned.failureText;
        props.session.onDelivered('branch');
        if (currentAddress === sentAddress) {
          setAddress({ kind: 'branch', sessionId: spawned.branchId, aboutTitle: sentAddress.aboutTitle });
        }
        return null;
      });
    }
    if (sentAddress.kind === 'branch') return sendToAgent(sentAddress.sessionId, text);
    const pending: PendingSend = { text, entryIdsAtDispatch: null, isClaimed: false, isAwaitingOutboxEcho: false };
    pendingSends = [...pendingSends, pending];
    paintQueue();
    const dispatchToMain = () => {
      pending.entryIdsAtDispatch = new Set(props.session.outbox().map((entry) => entry.entryId));
      return sendToAgent(props.session.sessionId, text).then((sendFailure) => {
        pending.isAwaitingOutboxEcho = sendFailure === null;
        return sendFailure;
      });
    };
    const askProgress = () => (
      text.trim().length > PROGRESS_QUESTION_MAX_CHARS
        ? Promise.resolve(false)
        : studioProgressAskAction({ id: props.session.sessionId, text })
          .then((outcome) => outcome.ok && outcome.reply.type === 'studio-progress-ask-result' && outcome.reply.isAnswered)
    );
    const mainSend = mainSendQueue.then(askProgress)
      .then((isAnswered) => (isAnswered ? deliveredAs('progress', Promise.resolve(null)) : deliveredAs('talk', dispatchToMain())))
      .finally(() => settlePendingSend(pending));
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
    const shownBranchIds = new Set(branches.map((branch) => branch.sessionId));
    for (const [sessionId, feed] of feedBySessionId) {
      if (sessionId === props.session.sessionId || shownBranchIds.has(sessionId)) continue;
      feed.close();
      feedBySessionId.delete(sessionId);
      speakerBySessionId.delete(sessionId);
      forgetTurnStarts(sessionId);
      if (currentAddress.kind === 'branch' && currentAddress.sessionId === sessionId) setAddress(MAIN_ADDRESS);
    }
    for (const branch of branches) {
      const speaker: FeedSpeaker = { sessionId: branch.sessionId, name: branch.name, agentId: branch.agentId, branch };
      if (feedBySessionId.has(branch.sessionId)) {
        speakerBySessionId.set(branch.sessionId, speaker);
        continue;
      }
      openFeed(speaker, branch.workingDirectory, branch.isTurnOver);
    }
  };

  const toggleExpanded = (key: string, bubbleElement: HTMLElement | null): void => {
    setExpandedRowKeys((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
    queueMicrotask(() => {
      bubbleElement?.focus();
    });
  };

  const handle: DockHandle = {
    setBranches,
    addressSession: (sessionId, name) => {
      setAddress(sessionId === null || sessionId === props.session.sessionId ? MAIN_ADDRESS : { kind: 'branch', sessionId, aboutTitle: name });
      composerRef?.input.focus();
    },
    addressBox: (boxId, title) => {
      setAddress({ kind: 'new-branch', aboutBoxId: boxId, aboutTitle: title });
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
      setProgressAnswers([...props.session.progressAnswers()]);
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
        if (event.key === 'Backspace' && input.value.length === 0 && currentAddress.kind !== 'main') {
          setAddress(MAIN_ADDRESS);
          return;
        }
        if (event.key === 'Escape' && currentMentionChoices.length === 0 && currentAddress.kind === 'new-branch') {
          event.preventDefault();
          setAddress(MAIN_ADDRESS);
          return;
        }
        if (currentMentionChoices.length === 0) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
          closeMentions();
          return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          currentActiveChoiceIndex = stepMentionIndex(currentActiveChoiceIndex, step, currentMentionChoices.length);
          setActiveChoiceIndex(currentActiveChoiceIndex);
          syncInputActiveDescendant();
          return;
        }
        if (event.key !== 'Enter' && event.key !== 'Tab') return;
        const choice = currentMentionChoices[currentActiveChoiceIndex];
        if (!choice) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        pickChoice(choice);
      },
      { capture: true, signal: dockListeners.signal },
    );

    pill.addEventListener(
      'chat-draft',
      (event) => {
        const text = stringDetailOf(event, 'text');
        if (text === null) return;
        if (
          event instanceof CustomEvent
          && typeof event.detail === 'object'
          && event.detail !== null
          && Reflect.get(event.detail, 'isImmediate') === true
        ) {
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
        const sentAddress = currentAddress;
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
        const sessionId = addressedSessionIdOf(currentAddress, session.sessionId);
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
      claimPendingSends(pendingSends, session.outbox());
      pendingSends = pendingSends.filter((pending) => !pending.isAwaitingOutboxEcho);
      paintQueue();
    });

    const stopFollowingBoardChanges = onAgentChange((_sessionId, boardChange) => {
      if (boardChange.boardId === session.mapBoardId()) setBoardChangeVersion((count) => count + 1);
    });

    const mainSpeaker: FeedSpeaker = {
      sessionId: session.sessionId,
      name: session.name,
      agentId: session.agentId,
      branch: null,
    };
    const mainFeed = openFeed(mainSpeaker, session.workingDirectory, session.isTurnOver);
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
      data-log-open={isLogOpen() ? 'true' : undefined}
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
                      when={row().kind === 'part' ? (row() as PartRowEntry) : undefined}
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

                        const turnShown = createMemo<TurnShownText | null>(() => {
                          digestVersion();
                          const current = partRow();
                          if (current.part.kind !== 'turn') return null;
                          const attribution = attributionBySessionId().get(current.sessionId);
                          const chatLine = current.part.openedAt === null
                            ? null
                            : props.session.digestOf(current.sessionId, current.part.openedAt);
                          const isBranchNews = attribution?.branchNewsTurnIds.has(current.part.id) ?? false;
                          return shownTextOfTurn(current.part, current.speaker.branch !== null, chatLine, isBranchNews);
                        });

                        const turnBoardChange = createMemo<AgentChip | null>(() => {
                          const current = partRow();
                          if (current.part.kind !== 'turn') return null;
                          return attributionBySessionId().get(current.sessionId)?.boardChangeByTurnId.get(current.part.id) ?? null;
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
                                when={turnShown()}
                                fallback={
                                  <div
                                    class="bs-row bs-row-agent"
                                    data-part-id={partRow().part.id}
                                    data-session-id={partRow().sessionId}
                                    data-board-change-at={String(turnBoardChange()?.at ?? '')}
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
                                    data-board-change-at={String(turnBoardChange()?.at ?? '')}
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
                                              if (latestBranch !== null) addressBranch(latestBranch);
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
                                            toggleExpanded(partRow().key, bubbleElement ?? null);
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
                                        <Show when={turnBoardChange()}>
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
              <For each={queueView().standInPrompts} keyed={(standIn) => standIn.id}>
                {(standIn) => (
                  <div class="bs-row bs-row-you" hidden={standIn().isBoardAnswer}>
                    <div
                      class="bs-bubble bs-bubble-you"
                      ref={markdownDirective(() => standIn().text)}
                    />
                  </div>
                )}
              </For>
              <For each={queueView().queuedEntries} keyed={(entry) => entry.entryId}>
                {(entry) => (
                  <div class="bs-row bs-row-you bs-row-queued" data-state={entry().state}>
                    <div class="bs-queued-meta">
                      <span class="bs-queued-status">{studioQueuedStatusOf(entry())}</span>
                      <Button
                        variant="quiet"
                        size="small"
                        textCase="inline"
                        label="Cancel"
                        disabled={
                          entry().state === 'sending'
                          || isOptimisticOutboxEntryId(entry().entryId)
                          || cancellingEntryIds().has(entry().entryId)
                        }
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
              <For each={queueView().pendingSends} keyed={false}>
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
                aria-selected={entry.index === activeChoiceIndex() ? 'true' : 'false'}
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
        hidden={address().kind === 'main'}
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
