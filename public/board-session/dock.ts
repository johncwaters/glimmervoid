import { renderCard } from '../chat/chat-cards.ts';
import { createChatFeed } from '../chat/chat-feed.ts';
import { createComposer } from '../chat/composer.ts';
import { stringDetailOf } from '../chat/chat-page.ts';
import type { RailField } from '../chat/status-rail-core.ts';
import { BRANCH_PROMPT_MAX_CHARS } from '#shared/contracts/control/board-session-messages.ts';
import { CHAT_SEND_MAX_CHARS } from '#shared/contracts/control/session-messages.ts';
import type { ChatFeed } from '../chat/chat-feed.ts';
import type { ChatPart } from '../chat/chat-part.ts';
import type { SessionProgressAnswer } from '#shared/contracts/director-digests.ts';
import { operatorPartOfPrompt } from '#shared/board-branch-core.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { parsePlanMarkdown } from '../plan/plan-markdown-core.ts';
import { renderPlanBlocks } from '../plan/plan-render.ts';
import { paintAgentMark } from '../session-card/agent-mark.ts';
import { createLineIcon } from '../svg-dom.ts';
import { createPressable, labelIconPressable } from '../ui/pressable.ts';
import { errorMessage } from '#shared/text.ts';
import { addressLabelOf, boxMentionAt, matchingBoxChoices, textWithoutMention } from './branch-core.ts';
import type { BoxChoice, BoxMention, DockAddress } from './branch-core.ts';

const TRACE_PAGE_TIMEOUT_MS = 10000;
const CHAT_SEND_TIMEOUT_MS = 10000;
const PROGRESS_ASK_TIMEOUT_MS = 130000;
const GLIMMERVOID_NAME = 'Glimmervoid';
const BRANCH_SPAWN_TIMEOUT_MS = 30000;
const NEAR_TOP_PX = 48;
const NEAR_BOTTOM_PX = 24;
const CLEAR_ICON_PATH = 'M4 4l8 8M12 4l-8 8';
const NOT_SENT_TEXT = 'The message was not sent.';
const MAIN_ADDRESS: DockAddress = { kind: 'main' };
const RAIL_TICK_MS = 30_000;
const NO_UPLOADS_URL = '';

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
}

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

function turnRowOf(part: Extract<ChatPart, { kind: 'turn' }>, speaker: FeedSpeaker, chatLine: string, options: TurnRowOptions): HTMLElement {
  const row = el('div', speaker.branch ? 'bs-row bs-row-agent bs-row-branch' : 'bs-row bs-row-agent');
  row.dataset.digest = chatLine;
  row.dataset.expanded = String(options.isExpanded);
  const bubble = el('div', 'bs-bubble bs-bubble-agent');
  const body = el('div', 'bs-bubble-body');
  body.append(el('p', 'bs-digest', chatLine));
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
  return row;
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

function digestOfTurn(part: Extract<ChatPart, { kind: 'turn' }>, speaker: FeedSpeaker, digestOf: DockSession['digestOf']): string | null {
  if (part.openedAt === null) return null;
  return digestOf(speaker.sessionId, part.openedAt);
}

function renderedPartOf(part: ChatPart, speaker: FeedSpeaker, digestOf: DockSession['digestOf'], options: TurnRowOptions): HTMLElement | null {
  if (part.kind === 'prompt') return promptRowOf(part, speaker);
  if (part.kind === 'turn') {
    const chatLine = digestOfTurn(part, speaker, digestOf);
    if (chatLine !== null) return turnRowOf(part, speaker, chatLine, options);
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
  element.append(log, failure, mentions, pill);

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
  const isNearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight <= NEAR_BOTTOM_PX;
  const keepingBottom = (change: () => void) => {
    const wasNearBottom = isNearBottom();
    change();
    if (wasNearBottom) log.scrollTop = log.scrollHeight;
  };

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
    const laterRow = [...log.children].find((child) => child instanceof HTMLElement && child.dataset.at !== undefined && Number(child.dataset.at) > rowTime);
    if (laterRow) return laterRow.before(row);
    log.append(row);
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
        toggleExpanded: () => keepingBottom(() => {
          if (!expandedRowKeys.delete(key)) expandedRowKeys.add(key);
          upsertParts(sessionId, [turnByKey.get(key)?.part ?? part]);
          rowByKey.get(key)?.querySelector<HTMLElement>('.bs-bubble-agent')?.focus();
        }),
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
      log.append(row);
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

  const openFeed = (speaker: FeedSpeaker, workingDirectory: string | null, isTurnOver: () => boolean) => {
    const sessionId = speaker.sessionId;
    speakerBySessionId.set(sessionId, speaker);
    const feed = createChatFeed({
      sessionId,
      workingDirectory,
      requestPage: (payload) => sendControlRequest('session-trace', payload, { timeoutMs: TRACE_PAGE_TIMEOUT_MS }),
      onPartsChanged: (changedParts, droppedPartIds) => keepingBottom(() => {
        upsertParts(sessionId, changedParts);
        removeParts(sessionId, droppedPartIds);
      }),
      onRebuilt: (rebuiltParts, replacedPartIds) => {
        if (speaker.branch) {
          removeParts(sessionId, replacedPartIds);
          removeSessionRows(sessionId);
          return keepingBottom(() => upsertParts(sessionId, rebuiltParts));
        }
        const distanceFromBottom = log.scrollHeight - log.scrollTop;
        removeParts(sessionId, replacedPartIds);
        log.replaceChildren();
        rowByKey.clear();
        turnByKey.clear();
        shownAnswerKeys.clear();
        upsertParts(sessionId, rebuiltParts);
        paintProgressAnswers();
        log.scrollTop = log.scrollHeight - distanceFromBottom;
      },
      onBeats: () => {},
      onSubagents: () => {},
      isTurnOver,
      onReset: () => removeSessionRows(sessionId),
      onFailure: showFailure,
    });
    feedBySessionId.set(sessionId, feed);
    return feed;
  };

  const scrollLogToBottom = () => {
    log.scrollTop = log.scrollHeight;
  };
  const openLog = () => {
    if (element.dataset.logOpen === 'true') return;
    element.dataset.logOpen = 'true';
    scrollLogToBottom();
  };
  const openLogWhenTurnLive = () => {
    if (!session.isTurnOver()) openLog();
  };
  element.addEventListener('focusin', openLog);
  openLogWhenTurnLive();

  const mainFeed = openFeed(mainSpeaker, session.workingDirectory, session.isTurnOver);
  mainFeed.whenCaughtUp(() => {
    log.scrollTop = log.scrollHeight;
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

  const sendText = (text: string, sentAddress: DockAddress) => {
    if (sentAddress.kind === 'new-branch') {
      return requestBranchSpawn(session.sessionId, sentAddress.aboutBoxId, text)
        .then((spawned) => {
          if (spawned.branchId === null) return spawned.failureText;
          if (address === sentAddress) setAddress({ kind: 'branch', sessionId: spawned.branchId, aboutTitle: sentAddress.aboutTitle });
          return null;
        });
    }
    if (sentAddress.kind === 'branch') return sendToAgent(sentAddress.sessionId, text);
    const mainSend = mainSendQueue.then(() => sendControlRequest('studio-progress-ask', { id: session.sessionId, text }, { timeoutMs: PROGRESS_ASK_TIMEOUT_MS })
      .then((reply) => reply.type === 'studio-progress-ask-result' && reply.isAnswered)
      .catch(() => false)
      .then((isAnswered) => isAnswered ? null : sendToAgent(session.sessionId, text)));
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

  const paintComposer = () => {
    composer.setTurnRunning(isAddressedTurnRunning());
    composer.showRail(session.railFields());
  };

  pill.addEventListener('chat-send', (event) => {
    const text = stringDetailOf(event, 'text');
    if (text === null || text.length === 0) return;
    closeMentions();
    const sentAddress = address;
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
      for (const feed of feedBySessionId.values()) feed.refresh();
    },
    refreshDigests: () => keepingBottom(() => {
      for (const [key, { sessionId, part }] of turnByKey) {
        const speaker = speakerBySessionId.get(sessionId);
        if (!speaker) continue;
        const digest = digestOfTurn(part, speaker, session.digestOf);
        if ((rowByKey.get(key)?.dataset.digest ?? null) === digest) continue;
        upsertParts(sessionId, [part]);
      }
      paintProgressAnswers();
    }),
    close: () => {
      clearInterval(railTimer);
      for (const feed of feedBySessionId.values()) feed.close();
      feedBySessionId.clear();
    },
  };
}
