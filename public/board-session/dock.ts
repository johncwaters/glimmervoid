import { createChatActivity } from '../chat/chat-activity.ts';
import type { ActivityBeat, ChatPhase } from '../chat/chat-activity-core.ts';
import { renderCard } from '../chat/chat-cards.ts';
import { createChatFeed } from '../chat/chat-feed.ts';
import { createComposer } from '../chat/composer.ts';
import { STAND_IN_UNRECORDED_MAX_MS, draftWithRestoredText, stringDetailOf } from '../chat/chat-page.ts';
import { onChatOutboxNoted } from '../chat/chat-session-state.ts';
import { queuedStatusOf } from '../chat/chat-view.ts';
import { createOutboxEchoState, reconcileOutboxEcho, takeStandInsForPrompts } from '../chat/outbox-echo-core.ts';
import { stickToBottom } from '../chat/stick-to-bottom.ts';
import type { RailField } from '../chat/status-rail-core.ts';
import { BRANCH_PROMPT_MAX_CHARS } from '#shared/contracts/control/board-session-messages.ts';
import { CHAT_SEND_MAX_CHARS } from '#shared/contracts/control/session-messages.ts';
import type { ChatFeed } from '../chat/chat-feed.ts';
import type { ChatPart } from '../chat/chat-part.ts';
import type { SessionProgressAnswer } from '#shared/contracts/director-digests.ts';
import type { ChatOutboxEntry } from '#shared/contracts/session.ts';
import { operatorPartOfPrompt } from '#shared/board-branch-core.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { parsePlanMarkdown } from '../plan/plan-markdown-core.ts';
import { renderPlanBlocks } from '../plan/plan-render.ts';
import { paintAgentMark } from '../session-card/agent-mark.ts';
import { createLineIcon } from '../svg-dom.ts';
import { button } from '../ui/button.ts';
import { createPressable, labelIconPressable } from '../ui/pressable.ts';
import { errorMessage } from '#shared/text.ts';
import { clock } from '#shared/clock.ts';
import { addressLabelOf, boxMentionAt, matchingBoxChoices, textWithoutMention } from './branch-core.ts';
import type { BoxChoice, BoxMention, DockAddress } from './branch-core.ts';

const TRACE_PAGE_TIMEOUT_MS = 10000;
const CHAT_SEND_TIMEOUT_MS = 10000;
const PROGRESS_ASK_TIMEOUT_MS = 130000;
const GLIMMERVOID_NAME = 'Glimmervoid';
const BRANCH_SPAWN_TIMEOUT_MS = 30000;
const NEAR_TOP_PX = 48;
const CLEAR_ICON_PATH = 'M4 4l8 8M12 4l-8 8';
const NOT_SENT_TEXT = 'The message was not sent.';
const MAIN_ADDRESS: DockAddress = { kind: 'main' };
const RAIL_TICK_MS = 30_000;
const NO_UPLOADS_URL = '';
const PENDING_RUNNING_STATUS_TEXT = 'Queued';
const PENDING_IDLE_STATUS_TEXT = 'Sending';

interface DockActivity {
  phase: ChatPhase;
  beat: ActivityBeat | null;
}

interface DockSession {
  sessionId: string;
  name: string;
  workingDirectory: string | null;
  agentId: string | null;
  isTurnOver: () => boolean;
  boxChoices: () => readonly BoxChoice[];
  digestOf: (sessionId: string, openedAt: number) => string | null;
  progressAnswers: () => readonly SessionProgressAnswer[];
  railFields: () => readonly RailField[];
  onDelivered: (kind: DockDelivery) => void;
  outbox: () => readonly ChatOutboxEntry[];
  activity: () => DockActivity;
}

type DockDelivery = 'talk' | 'branch' | 'progress';

export interface DockBranch {
  sessionId: string;
  name: string;
  workingDirectory: string | null;
  agentId: string | null;
  aboutTitle: string;
  isTurnOver: () => boolean;
}

export interface Dock {
  element: HTMLElement;
  setBranches(branches: readonly DockBranch[]): void;
  addressSession(sessionId: string | null, name: string): void;
  addressBox(boxId: string, title: string): void;
  refresh(): void;
  refreshDigests(): void;
  paintActivity(): void;
  close(): void;
}

interface FeedSpeaker {
  sessionId: string;
  name: string;
  agentId: string | null;
  branch: DockBranch | null;
}

function agentFaceOf(speaker: FeedSpeaker): HTMLElement {
  const face = el('span', speaker.branch ? 'bs-face bs-face-branch' : 'bs-face');
  paintAgentMark(face, speaker.agentId, speaker.name);
  return face;
}

function fullReplyOf(part: Extract<ChatPart, { kind: 'turn' }>): HTMLElement {
  const replyTexts = part.segments.flatMap((segment) => segment.kind === 'text' && segment.text.trim().length > 0 ? [segment.text] : []);
  const fullReply = el('div', 'bs-full-reply');
  fullReply.append(...replyTexts.map((replyText) => renderPlanBlocks(parsePlanMarkdown(replyText))));
  return fullReply;
}

interface TurnShownText {
  kind: 'chat-line' | 'last-reply';
  text: string;
}

interface TurnRowOptions {
  isExpanded: boolean;
  toggleExpanded: () => void;
  addressBranch: (branch: DockBranch) => void;
}

function isInsideFullReply(eventTarget: EventTarget | null): boolean {
  return eventTarget instanceof Element && eventTarget.closest('.bs-full-reply') !== null;
}

function pressableOnKeys(target: HTMLElement, label: string, press: () => void): void {
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

function shownTextElementOf(shownText: TurnShownText): HTMLElement {
  if (shownText.kind === 'chat-line') return el('p', 'bs-digest', shownText.text);
  const lastReply = el('div', 'bs-digest bs-last-reply');
  lastReply.append(renderPlanBlocks(parsePlanMarkdown(shownText.text)));
  return lastReply;
}

function turnRowOf(part: Extract<ChatPart, { kind: 'turn' }>, speaker: FeedSpeaker, shownText: TurnShownText, options: TurnRowOptions): HTMLElement {
  const row = el('div', speaker.branch ? 'bs-row bs-row-agent bs-row-branch' : 'bs-row bs-row-agent');
  row.dataset.digest = shownText.text;
  row.dataset.expanded = String(options.isExpanded);
  const bubble = el('div', 'bs-bubble bs-bubble-agent');
  const body = el('div', 'bs-bubble-body');
  body.append(shownTextElementOf(shownText));
  if (options.isExpanded) body.append(fullReplyOf(part));
  bubble.append(el('span', 'bs-bubble-who', speaker.name), body);
  bubble.setAttribute('aria-expanded', String(options.isExpanded));
  pressableOnKeys(bubble, `Whole reply from ${speaker.name}`, options.toggleExpanded);
  const face = agentFaceOf(speaker);
  row.append(face, bubble);
  const branch = speaker.branch;
  if (branch !== null) pressableOnKeys(face, `Reply to ${branch.name}`, () => options.addressBranch(branch));
  return row;
}

function promptRowOf(part: Extract<ChatPart, { kind: 'prompt' }>, speaker: FeedSpeaker): HTMLElement {
  const row = el('div', speaker.branch ? 'bs-row bs-row-you bs-row-branch' : 'bs-row bs-row-you');
  const bubble = el('div', 'bs-bubble bs-bubble-you');
  if (speaker.branch) bubble.append(el('span', 'bs-bubble-who', `To ${speaker.branch.aboutTitle}`));
  bubble.append(renderPlanBlocks(parsePlanMarkdown(speaker.branch ? operatorPartOfPrompt(part.text) : part.text)));
  row.append(bubble);
  row.hidden = part.isBoardAnswer;
  return row;
}

interface PendingSend {
  text: string;
  entryIdsAtDispatch: ReadonlySet<string> | null;
  isClaimed: boolean;
}

function queuedRowOf(text: string, statusText: string, state: string, cancelButton: HTMLButtonElement): HTMLElement {
  const row = el('div', 'bs-row bs-row-you bs-row-queued');
  row.dataset.state = state;
  const meta = el('div', 'bs-queued-meta');
  meta.append(el('span', 'bs-queued-status', statusText), cancelButton);
  const bubble = el('div', 'bs-bubble bs-bubble-you');
  bubble.append(renderPlanBlocks(parsePlanMarkdown(text)));
  row.append(meta, bubble);
  return row;
}

function cancelButtonOf(isDisabled: boolean): HTMLButtonElement {
  return button({ variant: 'quiet', size: 'small', textCase: 'inline', label: 'Cancel', disabled: isDisabled });
}

function progressAnswerRowsOf(entry: SessionProgressAnswer): HTMLElement[] {
  const questionRow = el('div', 'bs-row bs-row-you');
  const questionBubble = el('div', 'bs-bubble bs-bubble-you');
  questionBubble.append(renderPlanBlocks(parsePlanMarkdown(entry.question)));
  questionRow.append(questionBubble);
  const answerRow = el('div', 'bs-row bs-row-agent bs-row-glimmervoid');
  const answerBubble = el('div', 'bs-bubble bs-bubble-agent');
  answerBubble.append(el('span', 'bs-bubble-who', GLIMMERVOID_NAME), el('p', 'bs-digest', entry.answer));
  answerRow.append(answerBubble);
  for (const row of [questionRow, answerRow]) row.dataset.at = String(entry.askedAt);
  return [questionRow, answerRow];
}

function partTimeOf(part: ChatPart): number | null {
  if (part.kind === 'prompt') return part.at;
  if (part.kind === 'turn') return part.openedAt;
  return null;
}

function chatLineOfTurn(part: Extract<ChatPart, { kind: 'turn' }>, speaker: FeedSpeaker, digestOf: DockSession['digestOf']): string | null {
  if (part.openedAt === null) return null;
  return digestOf(speaker.sessionId, part.openedAt);
}

function lastReplyTextOf(part: Extract<ChatPart, { kind: 'turn' }>): string | null {
  const lastTextSegment = part.segments.findLast((segment) => segment.kind === 'text' && segment.text.trim().length > 0);
  return lastTextSegment?.kind === 'text' ? lastTextSegment.text : null;
}

function shownTextOfTurn(part: Extract<ChatPart, { kind: 'turn' }>, speaker: FeedSpeaker, digestOf: DockSession['digestOf']): TurnShownText | null {
  const chatLine = chatLineOfTurn(part, speaker, digestOf);
  if (chatLine !== null) return { kind: 'chat-line', text: chatLine };
  if (speaker.branch !== null || !part.isOver) return null;
  const lastReplyText = lastReplyTextOf(part);
  return lastReplyText === null ? null : { kind: 'last-reply', text: lastReplyText };
}

function renderedPartOf(part: ChatPart, speaker: FeedSpeaker, digestOf: DockSession['digestOf'], options: TurnRowOptions): HTMLElement | null {
  if (part.kind === 'prompt') return promptRowOf(part, speaker);
  if (part.kind === 'turn') {
    const shownText = shownTextOfTurn(part, speaker, digestOf);
    if (shownText !== null) return turnRowOf(part, speaker, shownText, options);
    const unshownTurn = el('div', 'bs-row bs-row-agent');
    unshownTurn.hidden = true;
    return unshownTurn;
  }
  if (part.kind !== 'card') return null;
  const row = el('div', 'bs-row bs-row-card');
  row.append(renderCard(part.card));
  return row;
}

function requestBranchSpawn(parentId: string, aboutBoxId: string, prompt: string): Promise<{ branchId: string | null; failureText: string }> {
  return sendControlRequest('branch-spawn', { id: parentId, aboutBoxId, prompt }, { timeoutMs: BRANCH_SPAWN_TIMEOUT_MS })
    .then((reply) => {
      if (reply.type !== 'branch-spawn-result') return { branchId: null, failureText: NOT_SENT_TEXT };
      if (!reply.ok || reply.branchId === null) return { branchId: null, failureText: reply.error ?? NOT_SENT_TEXT };
      return { branchId: reply.branchId, failureText: '' };
    });
}

export function createDock(session: DockSession): Dock {
  const element = el('section', 'bs-dock');
  element.setAttribute('aria-label', 'Chat');
  const log = el('div', 'bs-log');
  log.setAttribute('role', 'log');
  const logRows = el('div', 'bs-log-rows');
  const queueRows = el('div', 'bs-log-queue');
  const logContent = el('div', 'bs-log-content');
  logContent.append(logRows, queueRows);
  log.append(logContent);
  const { jumpButton, followLatest } = stickToBottom(log, logContent);
  const jumpSlot = el('div', 'bs-jump-slot');
  jumpSlot.append(jumpButton);
  const logFrame = el('div', 'bs-log-frame');
  logFrame.append(log, jumpSlot);
  const failure = el('p', 'bs-failure');
  failure.setAttribute('role', 'status');
  failure.hidden = true;
  const mentions = el('div', 'bs-mentions');
  mentions.setAttribute('role', 'listbox');
  mentions.setAttribute('aria-label', 'Boxes');
  mentions.hidden = true;
  const composer = createComposer(() => NO_UPLOADS_URL);
  const pill = composer.element;
  pill.classList.add('bs-pill');
  const addressChip = el('span', 'bs-pill-address');
  const addressText = el('span', 'bs-pill-address-text');
  const clearAddressButton = createPressable('bs-pill-address-clear');
  labelIconPressable(clearAddressButton, `Message ${session.name}`);
  clearAddressButton.dataset.action = 'board-session-address-main';
  clearAddressButton.append(createLineIcon(CLEAR_ICON_PATH, '1.6'));
  addressChip.append(addressText, clearAddressButton);
  addressChip.hidden = true;
  const input = composer.input;
  input.classList.add('bs-pill-input');
  input.placeholder = `Message ${session.name}, or @ a box to branch`;
  input.setAttribute('aria-label', `Message ${session.name}`);
  input.setAttribute('aria-autocomplete', 'list');
  input.before(addressChip);
  const activity = createChatActivity();
  logContent.append(activity.element);
  element.append(logFrame, failure, mentions, pill);

  const rowByKey = new Map<string, HTMLElement>();
  const expandedRowKeys = new Set<string>();
  const turnByKey = new Map<string, { sessionId: string; part: Extract<ChatPart, { kind: 'turn' }> }>();
  const feedBySessionId = new Map<string, ChatFeed>();
  const speakerBySessionId = new Map<string, FeedSpeaker>();
  const mainSpeaker: FeedSpeaker = { sessionId: session.sessionId, name: session.name, agentId: session.agentId, branch: null };
  let address: DockAddress = MAIN_ADDRESS;
  let mention: BoxMention | null = null;
  let mentionChoices: BoxChoice[] = [];
  let activeChoiceIndex = 0;
  const branchTurnOverBySessionId = new Map<string, () => boolean>();

  const rowKeyOf = (sessionId: string, partId: string) => `${sessionId}:${partId}`;

  const showFailure = (failureText: string | null) => {
    failure.hidden = failureText === null;
    failure.textContent = failureText ?? '';
  };

  const paintAddress = () => {
    addressChip.hidden = address.kind === 'main';
    addressText.textContent = addressLabelOf(address);
  };

  const setAddress = (nextAddress: DockAddress) => {
    address = nextAddress;
    input.maxLength = nextAddress.kind === 'new-branch' ? BRANCH_PROMPT_MAX_CHARS : CHAT_SEND_MAX_CHARS;
    paintAddress();
    paintComposer();
  };

  const addressBranch = (branch: DockBranch) => {
    setAddress({ kind: 'branch', sessionId: branch.sessionId, aboutTitle: branch.aboutTitle });
    input.focus();
  };

  const shownAnswerKeys = new Set<string>();
  const insertByTime = (row: HTMLElement) => {
    const rowTime = Number(row.dataset.at);
    const laterRow = [...logRows.children].find((child) => child instanceof HTMLElement && child.dataset.at !== undefined && Number(child.dataset.at) > rowTime);
    if (laterRow) return laterRow.before(row);
    logRows.append(row);
  };
  const paintProgressAnswers = () => {
    for (const entry of session.progressAnswers()) {
      const answerKey = String(entry.askedAt);
      if (shownAnswerKeys.has(answerKey)) continue;
      shownAnswerKeys.add(answerKey);
      for (const row of progressAnswerRowsOf(entry)) insertByTime(row);
    }
  };

  const upsertParts = (sessionId: string, parts: readonly ChatPart[]) => {
    const speaker = speakerBySessionId.get(sessionId);
    if (!speaker) return;
    for (const part of parts) {
      const key = rowKeyOf(sessionId, part.id);
      if (part.kind === 'turn') turnByKey.set(key, { sessionId, part });
      const row = renderedPartOf(part, speaker, session.digestOf, {
        isExpanded: expandedRowKeys.has(key),
        toggleExpanded: () => {
          if (!expandedRowKeys.delete(key)) expandedRowKeys.add(key);
          upsertParts(sessionId, [turnByKey.get(key)?.part ?? part]);
          rowByKey.get(key)?.querySelector<HTMLElement>('.bs-bubble-agent')?.focus();
        },
        addressBranch,
      });
      if (row === null) {
        rowByKey.get(key)?.remove();
        rowByKey.delete(key);
        continue;
      }
      row.dataset.partId = part.id;
      row.dataset.sessionId = sessionId;
      const partTime = partTimeOf(part);
      if (partTime !== null) row.dataset.at = String(partTime);
      const shownRow = rowByKey.get(key);
      rowByKey.set(key, row);
      if (shownRow) {
        shownRow.replaceWith(row);
        continue;
      }
      logRows.append(row);
    }
  };

  const removeParts = (sessionId: string, partIds: readonly string[]) => {
    for (const partId of partIds) {
      const key = rowKeyOf(sessionId, partId);
      rowByKey.get(key)?.remove();
      rowByKey.delete(key);
      turnByKey.delete(key);
    }
  };

  const removeSessionRows = (sessionId: string) => {
    for (const [key, row] of rowByKey) {
      if (row.dataset.sessionId !== sessionId) continue;
      row.remove();
      rowByKey.delete(key);
      turnByKey.delete(key);
    }
  };

  const outboxEcho = createOutboxEchoState();
  const shownPromptPartIds = new Set<string>();
  const unrecordedTimerByEntryId = new Map<string, ReturnType<typeof setTimeout>>();
  let pendingSends: PendingSend[] = [];
  const removeStandIns = (entryIds: readonly string[]) => {
    for (const entryId of entryIds) {
      outboxEcho.standInByEntryId.delete(entryId);
      clearTimeout(unrecordedTimerByEntryId.get(entryId));
      unrecordedTimerByEntryId.delete(entryId);
    }
  };
  const takeRecordedPrompts = (changedParts: readonly ChatPart[], droppedPartIds: readonly string[], isLive: boolean) => {
    for (const droppedPartId of droppedPartIds) shownPromptPartIds.delete(droppedPartId);
    const newPromptParts = changedParts.filter((part) => part.kind === 'prompt' && !part.isBoardAnswer && !shownPromptPartIds.has(part.id));
    for (const promptPart of newPromptParts) shownPromptPartIds.add(promptPart.id);
    if (!isLive) return;
    const takenEntryIds = takeStandInsForPrompts(outboxEcho, newPromptParts.length);
    removeStandIns(takenEntryIds);
    if (takenEntryIds.length > 0) paintQueue();
  };

  const openFeed = (speaker: FeedSpeaker, workingDirectory: string | null, isTurnOver: () => boolean) => {
    const sessionId = speaker.sessionId;
    speakerBySessionId.set(sessionId, speaker);
    const feed = createChatFeed({
      sessionId,
      workingDirectory,
      requestPage: (payload) => sendControlRequest('session-trace', payload, { timeoutMs: TRACE_PAGE_TIMEOUT_MS }),
      onPartsChanged: (changedParts, droppedPartIds, isLive) => {
        if (!speaker.branch) takeRecordedPrompts(changedParts, droppedPartIds, isLive);
        upsertParts(sessionId, changedParts);
        removeParts(sessionId, droppedPartIds);
      },
      onRebuilt: (rebuiltParts, replacedPartIds) => {
        if (speaker.branch) {
          removeParts(sessionId, replacedPartIds);
          removeSessionRows(sessionId);
          return upsertParts(sessionId, rebuiltParts);
        }
        const distanceFromBottom = log.scrollHeight - log.scrollTop;
        removeParts(sessionId, replacedPartIds);
        logRows.replaceChildren();
        rowByKey.clear();
        turnByKey.clear();
        shownAnswerKeys.clear();
        shownPromptPartIds.clear();
        for (const part of rebuiltParts) if (part.kind === 'prompt') shownPromptPartIds.add(part.id);
        upsertParts(sessionId, rebuiltParts);
        paintProgressAnswers();
        log.scrollTop = log.scrollHeight - distanceFromBottom;
      },
      onBeats: () => {},
      isTurnOver,
      onReset: () => {
        if (!speaker.branch) shownPromptPartIds.clear();
        removeSessionRows(sessionId);
      },
      onFailure: showFailure,
    });
    feedBySessionId.set(sessionId, feed);
    return feed;
  };

  const openLog = () => {
    if (element.dataset.logOpen === 'true') return;
    element.dataset.logOpen = 'true';
    followLatest();
  };
  const openLogWhenTurnLive = () => {
    if (!session.isTurnOver()) openLog();
  };
  const foldLogWhenTurnOver = () => {
    if (session.isTurnOver() && !isAddressedTurnRunning()) delete element.dataset.logOpen;
  };
  const isOutsideDock = (target: EventTarget | null) => target instanceof Node && !element.contains(target);
  const dockListeners = new AbortController();
  element.addEventListener('focusin', openLog);
  element.addEventListener('focusout', (event) => {
    if (isOutsideDock(event.relatedTarget)) foldLogWhenTurnOver();
  });
  document.addEventListener('pointerdown', (event) => {
    if (isOutsideDock(event.target)) foldLogWhenTurnOver();
  }, { capture: true, signal: dockListeners.signal });
  openLogWhenTurnLive();

  const mainFeed = openFeed(mainSpeaker, session.workingDirectory, session.isTurnOver);
  mainFeed.whenCaughtUp(followLatest);

  const restoreToBar = (text: string) => composer.restoreDraft(draftWithRestoredText(text, composer.readDraft()));
  const cancelEntry = (entryId: string) => {
    sendControlRequest('chat-cancel', { id: session.sessionId, entryId }, { timeoutMs: CHAT_SEND_TIMEOUT_MS })
      .then((reply) => {
        if (reply.type !== 'chat-cancel-result' || reply.cancelledTexts.length === 0) return;
        restoreToBar(reply.cancelledTexts.join('\n\n'));
      })
      .catch((reason: unknown) => showFailure(`Could not cancel the message: ${errorMessage(reason)}`));
  };
  const awaitPromptFor = (entryId: string) => {
    if (unrecordedTimerByEntryId.has(entryId)) return;
    unrecordedTimerByEntryId.set(entryId, setTimeout(() => {
      mainFeed.whenCaughtUp(() => {
        removeStandIns([entryId]);
        paintQueue();
      });
      mainFeed.refresh();
    }, STAND_IN_UNRECORDED_MAX_MS));
  };
  const claimPendingSends = (entries: readonly ChatOutboxEntry[]) => {
    const claimedEntryIds = new Set<string>();
    for (const pending of pendingSends) {
      const dispatchedEntryIds = pending.entryIdsAtDispatch;
      if (pending.isClaimed || dispatchedEntryIds === null) continue;
      const claimedEntry = entries.find((entry) => entry.text === pending.text && !dispatchedEntryIds.has(entry.entryId) && !claimedEntryIds.has(entry.entryId));
      if (claimedEntry === undefined) continue;
      claimedEntryIds.add(claimedEntry.entryId);
      pending.isClaimed = true;
    }
  };
  const queuedEntryRowOf = (entry: ChatOutboxEntry) => {
    const cancelButton = cancelButtonOf(entry.state === 'sending');
    cancelButton.addEventListener('click', () => {
      cancelButton.disabled = true;
      cancelEntry(entry.entryId);
    });
    return queuedRowOf(entry.text, queuedStatusOf(entry), entry.state, cancelButton);
  };
  const pendingRowOf = (pending: PendingSend) => queuedRowOf(pending.text, session.isTurnOver() ? PENDING_IDLE_STATUS_TEXT : PENDING_RUNNING_STATUS_TEXT, 'pending', cancelButtonOf(true));
  const paintQueue = () => {
    const entries = session.outbox();
    const update = reconcileOutboxEcho(outboxEcho, entries, !session.isTurnOver(), clock.nowMs());
    removeStandIns(update.removedStandInEntryIds);
    for (const entryId of update.clearedStandInEntryIds) awaitPromptFor(entryId);
    claimPendingSends(entries);
    const shownPendingSends = pendingSends.filter((pending) => !pending.isClaimed);
    const standInRows = [...outboxEcho.standInByEntryId.values()].flatMap((standIn) => standIn.kind === 'prompt' ? [promptRowOf(standIn, mainSpeaker)] : []);
    queueRows.replaceChildren(...standInRows, ...update.queuedEntries.map(queuedEntryRowOf), ...shownPendingSends.map(pendingRowOf));
    if (update.clearedStandInEntryIds.length > 0) mainFeed.refresh();
  };
  const dropPendingSend = (pending: PendingSend) => {
    pendingSends = pendingSends.filter((candidate) => candidate !== pending);
    paintQueue();
  };
  const stopFollowingOutbox = onChatOutboxNoted((sessionId) => {
    if (sessionId === session.sessionId) paintQueue();
  });

  const closeMentions = () => {
    mention = null;
    mentionChoices = [];
    mentions.hidden = true;
    mentions.replaceChildren();
    input.removeAttribute('aria-activedescendant');
  };

  const pickChoice = (choice: BoxChoice) => {
    if (mention === null) return;
    input.value = textWithoutMention(input.value, mention);
    closeMentions();
    setAddress({ kind: 'new-branch', aboutBoxId: choice.boxId, aboutTitle: choice.title });
    composer.restoreDraft(input.value);
    input.focus();
  };

  const paintMentions = () => {
    const items = mentionChoices.map((choice, index) => {
      const item = createPressable('bs-mention', choice.title);
      item.id = `bs-mention-${index}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === activeChoiceIndex));
      item.dataset.boxId = choice.boxId;
      item.addEventListener('pointerdown', (event) => event.preventDefault());
      item.addEventListener('click', () => pickChoice(choice));
      return item;
    });
    mentions.replaceChildren(...items);
    mentions.hidden = items.length === 0;
    if (items.length === 0) return input.removeAttribute('aria-activedescendant');
    input.setAttribute('aria-activedescendant', `bs-mention-${activeChoiceIndex}`);
  };

  const readMention = () => {
    mention = boxMentionAt(input.value, input.selectionStart ?? input.value.length);
    if (mention === null) return closeMentions();
    mentionChoices = matchingBoxChoices(session.boxChoices(), mention.query);
    activeChoiceIndex = 0;
    paintMentions();
  };

  log.addEventListener('scroll', () => {
    if (log.scrollTop <= NEAR_TOP_PX) mainFeed.loadEarlier();
  });

  clearAddressButton.addEventListener('click', () => {
    setAddress(MAIN_ADDRESS);
    input.focus();
  });

  input.addEventListener('input', readMention);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Backspace' && input.value.length === 0 && address.kind !== 'main') return setAddress(MAIN_ADDRESS);
    if (event.key === 'Escape' && mentions.hidden && address.kind === 'new-branch') {
      event.preventDefault();
      return setAddress(MAIN_ADDRESS);
    }
    if (mentions.hidden || mentionChoices.length === 0) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      return closeMentions();
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      activeChoiceIndex = (activeChoiceIndex + step + mentionChoices.length) % mentionChoices.length;
      return paintMentions();
    }
    if (event.key !== 'Enter' && event.key !== 'Tab') return;
    const choice = mentionChoices[activeChoiceIndex];
    if (!choice) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    pickChoice(choice);
  }, { capture: true });

  input.addEventListener('blur', closeMentions);

  let mainSendQueue: Promise<string | null> = Promise.resolve(null);
  const sendToAgent = (targetId: string, text: string) => sendControlRequest('chat-send', { id: targetId, text, attachments: [] }, { timeoutMs: CHAT_SEND_TIMEOUT_MS })
    .then((reply) => {
      if (reply.type === 'chat-send-result' && reply.ok) return null;
      return reply.type === 'chat-send-result' ? reply.error ?? NOT_SENT_TEXT : NOT_SENT_TEXT;
    });

  const deliveredAs = (kind: DockDelivery, sending: Promise<string | null>) => sending.then((failureText) => {
    if (failureText === null) session.onDelivered(kind);
    return failureText;
  });

  const sendText = (text: string, sentAddress: DockAddress) => {
    if (sentAddress.kind === 'new-branch') {
      return requestBranchSpawn(session.sessionId, sentAddress.aboutBoxId, text)
        .then((spawned) => {
          if (spawned.branchId === null) return spawned.failureText;
          session.onDelivered('branch');
          if (address === sentAddress) setAddress({ kind: 'branch', sessionId: spawned.branchId, aboutTitle: sentAddress.aboutTitle });
          return null;
        });
    }
    if (sentAddress.kind === 'branch') return sendToAgent(sentAddress.sessionId, text);
    const pending: PendingSend = { text, entryIdsAtDispatch: null, isClaimed: false };
    pendingSends = [...pendingSends, pending];
    paintQueue();
    const dispatchToMain = () => {
      pending.entryIdsAtDispatch = new Set(session.outbox().map((entry) => entry.entryId));
      return sendToAgent(session.sessionId, text);
    };
    const mainSend = mainSendQueue.then(() => sendControlRequest('studio-progress-ask', { id: session.sessionId, text }, { timeoutMs: PROGRESS_ASK_TIMEOUT_MS })
      .then((reply) => reply.type === 'studio-progress-ask-result' && reply.isAnswered)
      .catch(() => false)
      .then((isAnswered) => isAnswered ? deliveredAs('progress', Promise.resolve(null)) : deliveredAs('talk', dispatchToMain())))
      .finally(() => dropPendingSend(pending));
    mainSendQueue = mainSend.catch(() => null);
    return mainSend;
  };

  const addressedSessionId = () => address.kind === 'branch' ? address.sessionId : address.kind === 'main' ? session.sessionId : null;

  const isAddressedTurnRunning = () => {
    const sessionId = addressedSessionId();
    if (sessionId === null) return false;
    if (sessionId === session.sessionId) return !session.isTurnOver();
    return feedBySessionId.has(sessionId) && !(branchTurnOverBySessionId.get(sessionId)?.() ?? true);
  };

  let shownActivityBeat: ActivityBeat | null = null;
  const paintActivity = () => {
    const { phase, beat } = session.activity();
    activity.setPhase(phase);
    if (beat !== null && beat !== shownActivityBeat) activity.beat([beat]);
    shownActivityBeat = beat;
  };

  const paintComposer = () => {
    composer.setTurnRunning(isAddressedTurnRunning());
    composer.showRail(session.railFields());
  };

  pill.addEventListener('chat-send', (event) => {
    const text = stringDetailOf(event, 'text');
    if (text === null || text.length === 0) return;
    closeMentions();
    const sentAddress = address;
    followLatest();
    const restoreText = (failureText: string) => {
      if (input.value.trim().length === 0) composer.restoreDraft(text);
      showFailure(failureText);
    };
    sendText(text, sentAddress)
      .then((failureText) => {
        if (failureText === null) return showFailure(null);
        restoreText(failureText);
      })
      .catch((reason: unknown) => restoreText(`Could not confirm the message was queued: ${errorMessage(reason)}`));
  });

  pill.addEventListener('chat-stop', () => {
    const sessionId = addressedSessionId();
    if (sessionId !== null) sendControlMsg({ type: 'chat-stop', id: sessionId });
  });

  paintComposer();
  paintQueue();
  paintActivity();
  const railTimer = setInterval(paintComposer, RAIL_TICK_MS);

  const setBranches = (branches: readonly DockBranch[]) => {
    branchTurnOverBySessionId.clear();
    for (const branch of branches) branchTurnOverBySessionId.set(branch.sessionId, branch.isTurnOver);
    const shownBranchIds = new Set(branches.map((branch) => branch.sessionId));
    for (const [sessionId, feed] of feedBySessionId) {
      if (sessionId === session.sessionId || shownBranchIds.has(sessionId)) continue;
      feed.close();
      feedBySessionId.delete(sessionId);
      speakerBySessionId.delete(sessionId);
      removeSessionRows(sessionId);
      if (address.kind === 'branch' && address.sessionId === sessionId) setAddress(MAIN_ADDRESS);
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

  return {
    element,
    setBranches,
    addressSession: (sessionId, name) => {
      setAddress(sessionId === null || sessionId === session.sessionId ? MAIN_ADDRESS : { kind: 'branch', sessionId, aboutTitle: name });
      input.focus();
    },
    addressBox: (boxId, title) => {
      setAddress({ kind: 'new-branch', aboutBoxId: boxId, aboutTitle: title });
      input.focus();
    },
    refresh: () => {
      openLogWhenTurnLive();
      paintComposer();
      paintQueue();
      paintActivity();
      for (const feed of feedBySessionId.values()) feed.refresh();
    },
    refreshDigests: () => {
      for (const [key, { sessionId, part }] of turnByKey) {
        const speaker = speakerBySessionId.get(sessionId);
        if (!speaker) continue;
        const shownText = shownTextOfTurn(part, speaker, session.digestOf)?.text ?? null;
        if ((rowByKey.get(key)?.dataset.digest ?? null) === shownText) continue;
        upsertParts(sessionId, [part]);
      }
      paintProgressAnswers();
    },
    paintActivity,
    close: () => {
      stopFollowingOutbox();
      for (const timer of unrecordedTimerByEntryId.values()) clearTimeout(timer);
      dockListeners.abort();
      clearInterval(railTimer);
      for (const feed of feedBySessionId.values()) feed.close();
      feedBySessionId.clear();
    },
  };
}
