import { renderCard } from '../chat/chat-cards.ts';
import { createChatFeed } from '../chat/chat-feed.ts';
import type { ChatFeed } from '../chat/chat-feed.ts';
import type { ChatPart } from '../chat/chat-part.ts';
import type { TraceRecord } from '#shared/contracts/trace.ts';
import { operatorPartOfPrompt } from '#shared/board-branch-core.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { parsePlanMarkdown } from '../plan/plan-markdown-core.ts';
import { renderPlanBlocks } from '../plan/plan-render.ts';
import { paintAgentMark } from '../session-card/agent-mark.ts';
import { createLineIcon } from '../svg-dom.ts';
import { button } from '../ui/button.ts';
import { createPressable, labelIconPressable } from '../ui/pressable.ts';
import { errorMessage } from '#shared/text.ts';
import { addressLabelOf, boxMentionAt, matchingBoxChoices, textWithoutMention } from './branch-core.ts';
import type { BoxChoice, BoxMention, DockAddress } from './branch-core.ts';

const TRACE_PAGE_TIMEOUT_MS = 10000;
const CHAT_SEND_TIMEOUT_MS = 10000;
const BRANCH_SPAWN_TIMEOUT_MS = 30000;
const NEAR_TOP_PX = 48;
const NEAR_BOTTOM_PX = 24;
const SEND_ICON_PATH = 'M8 13V3M3.5 7.5L8 3l4.5 4.5';
const CLEAR_ICON_PATH = 'M4 4l8 8M12 4l-8 8';
const NOT_SENT_TEXT = 'The message was not sent.';
const MAIN_ADDRESS: DockAddress = { kind: 'main' };

interface DockSession {
  sessionId: string;
  name: string;
  workingDirectory: string | null;
  agentId: string | null;
  isTurnOver: () => boolean;
  onRecords: (appendedRecords: readonly TraceRecord[]) => void;
  boxChoices: () => readonly BoxChoice[];
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
  refresh(): void;
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

function turnBodyOf(part: Extract<ChatPart, { kind: 'turn' }>): HTMLElement {
  const body = el('div', 'bs-bubble-body');
  for (const segment of part.segments) {
    if (segment.kind === 'text') {
      body.append(renderPlanBlocks(parsePlanMarkdown(segment.text)));
      continue;
    }
    body.append(el('p', 'bs-bubble-tools', segment.labels.at(-1) ?? ''));
  }
  return body;
}

function promptRowOf(part: Extract<ChatPart, { kind: 'prompt' }>, speaker: FeedSpeaker): HTMLElement {
  const row = el('div', speaker.branch ? 'bs-row bs-row-you bs-row-branch' : 'bs-row bs-row-you');
  const bubble = el('div', 'bs-bubble bs-bubble-you');
  if (speaker.branch) bubble.append(el('span', 'bs-bubble-who', `To ${speaker.branch.aboutTitle}`));
  bubble.append(renderPlanBlocks(parsePlanMarkdown(speaker.branch ? operatorPartOfPrompt(part.text) : part.text)));
  row.append(bubble);
  return row;
}

function renderedPartOf(part: ChatPart, speaker: FeedSpeaker, addressBranch: (branch: DockBranch) => void): HTMLElement {
  if (part.kind === 'prompt') return promptRowOf(part, speaker);
  if (part.kind === 'turn') {
    const row = el('div', speaker.branch ? 'bs-row bs-row-agent bs-row-branch' : 'bs-row bs-row-agent');
    const bubble = el('div', 'bs-bubble bs-bubble-agent');
    bubble.append(el('span', 'bs-bubble-who', speaker.name), turnBodyOf(part));
    row.append(agentFaceOf(speaker), bubble);
    const branch = speaker.branch;
    if (branch === null) return row;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Reply to ${branch.name}`);
    row.addEventListener('click', () => addressBranch(branch));
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      addressBranch(branch);
    });
    return row;
  }
  if (part.kind === 'skill') return el('p', 'bs-row bs-row-note', `Skill ${part.skillName}`);
  if (part.kind === 'subagent') return el('p', 'bs-row bs-row-note', part.task ? `Subagent ${part.subagentType}: ${part.task}` : `Subagent ${part.subagentType}`);
  const row = el('div', 'bs-row bs-row-card');
  row.append(renderCard(part.card));
  return row;
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
  const pill = el('form', 'bs-pill');
  const addressChip = el('span', 'bs-pill-address');
  const addressText = el('span', 'bs-pill-address-text');
  const clearAddressButton = createPressable('bs-pill-address-clear');
  labelIconPressable(clearAddressButton, `Message ${session.name}`);
  clearAddressButton.dataset.action = 'board-session-address-main';
  clearAddressButton.append(createLineIcon(CLEAR_ICON_PATH, '1.6'));
  addressChip.append(addressText, clearAddressButton);
  addressChip.hidden = true;
  const input = el('input', 'bs-pill-input');
  input.type = 'text';
  input.placeholder = `Message ${session.name}, or @ a box to branch`;
  input.setAttribute('aria-label', `Message ${session.name}`);
  input.setAttribute('aria-autocomplete', 'list');
  const sendButton = button({ variant: 'primary-icon', size: 'small', label: 'Send', icon: createLineIcon(SEND_ICON_PATH, '1.8'), action: 'board-session-send', disabled: true });
  sendButton.type = 'submit';
  pill.append(addressChip, input, sendButton);
  element.append(log, failure, mentions, pill);

  const rowByKey = new Map<string, HTMLElement>();
  const feedBySessionId = new Map<string, ChatFeed>();
  const speakerBySessionId = new Map<string, FeedSpeaker>();
  const mainSpeaker: FeedSpeaker = { sessionId: session.sessionId, name: session.name, agentId: session.agentId, branch: null };
  let address: DockAddress = MAIN_ADDRESS;
  let mention: BoxMention | null = null;
  let mentionChoices: BoxChoice[] = [];
  let activeChoiceIndex = 0;

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
    paintAddress();
  };

  const addressBranch = (branch: DockBranch) => {
    setAddress({ kind: 'branch', sessionId: branch.sessionId, aboutTitle: branch.aboutTitle });
    input.focus();
  };

  const upsertParts = (sessionId: string, parts: readonly ChatPart[]) => {
    const speaker = speakerBySessionId.get(sessionId);
    if (!speaker) return;
    for (const part of parts) {
      const key = rowKeyOf(sessionId, part.id);
      const row = renderedPartOf(part, speaker, addressBranch);
      row.dataset.partId = part.id;
      row.dataset.sessionId = sessionId;
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
    }
  };

  const removeSessionRows = (sessionId: string) => {
    for (const [key, row] of rowByKey) {
      if (row.dataset.sessionId !== sessionId) continue;
      row.remove();
      rowByKey.delete(key);
    }
  };

  const openFeed = (speaker: FeedSpeaker, workingDirectory: string | null, isTurnOver: () => boolean, onRecords: ((appendedRecords: readonly TraceRecord[]) => void) | undefined) => {
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
        upsertParts(sessionId, rebuiltParts);
        log.scrollTop = log.scrollHeight - distanceFromBottom;
      },
      onBeats: () => {},
      onSubagents: () => {},
      isTurnOver,
      onReset: () => removeSessionRows(sessionId),
      onFailure: showFailure,
      onRecords,
    });
    feedBySessionId.set(sessionId, feed);
    return feed;
  };

  const mainFeed = openFeed(mainSpeaker, session.workingDirectory, session.isTurnOver, session.onRecords);
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
    sendButton.disabled = input.value.trim().length === 0;
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

  input.addEventListener('input', () => {
    sendButton.disabled = input.value.trim().length === 0;
    readMention();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Backspace' && input.value.length === 0 && address.kind !== 'main') return setAddress(MAIN_ADDRESS);
    if (mentions.hidden || mentionChoices.length === 0) return;
    if (event.key === 'Escape') {
      event.preventDefault();
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
    pickChoice(choice);
  });

  input.addEventListener('blur', closeMentions);

  const sendText = (text: string, sentAddress: DockAddress) => {
    if (sentAddress.kind === 'new-branch') {
      return sendControlRequest('branch-spawn', { id: session.sessionId, aboutBoxId: sentAddress.aboutBoxId, aboutTitle: sentAddress.aboutTitle, prompt: text }, { timeoutMs: BRANCH_SPAWN_TIMEOUT_MS })
        .then((reply) => {
          if (reply.type !== 'branch-spawn-result') return NOT_SENT_TEXT;
          if (!reply.ok || reply.branchId === null) return reply.error ?? NOT_SENT_TEXT;
          if (address === sentAddress) setAddress({ kind: 'branch', sessionId: reply.branchId, aboutTitle: sentAddress.aboutTitle });
          return null;
        });
    }
    const targetId = sentAddress.kind === 'branch' ? sentAddress.sessionId : session.sessionId;
    return sendControlRequest('chat-send', { id: targetId, text, attachments: [] }, { timeoutMs: CHAT_SEND_TIMEOUT_MS })
      .then((reply) => {
        if (reply.type === 'chat-send-result' && reply.ok) return null;
        return reply.type === 'chat-send-result' ? reply.error ?? NOT_SENT_TEXT : NOT_SENT_TEXT;
      });
  };

  pill.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text.length === 0) return;
    input.value = '';
    sendButton.disabled = true;
    closeMentions();
    const sentAddress = address;
    const restoreText = (failureText: string) => {
      if (input.value.trim().length === 0) input.value = text;
      sendButton.disabled = input.value.trim().length === 0;
      showFailure(failureText);
    };
    sendText(text, sentAddress)
      .then((failureText) => {
        if (failureText === null) return showFailure(null);
        restoreText(failureText);
      })
      .catch((reason: unknown) => restoreText(`Could not confirm the message was queued: ${errorMessage(reason)}`));
  });

  const setBranches = (branches: readonly DockBranch[]) => {
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
      openFeed(speaker, branch.workingDirectory, branch.isTurnOver, undefined);
    }
  };

  return {
    element,
    setBranches,
    refresh: () => {
      for (const feed of feedBySessionId.values()) feed.refresh();
    },
    close: () => {
      for (const feed of feedBySessionId.values()) feed.close();
      feedBySessionId.clear();
    },
  };
}
