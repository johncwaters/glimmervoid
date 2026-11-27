import { isStudioCardAction, renderStudioCard } from '../chat/chat-cards.ts';
import { chatApprovalOf, chatPlanGateOf } from '../chat/chat-page.ts';
import { createChatWaits } from '../chat/chat-waits.ts';
import type { ChatWaitsView } from '../chat/chat-waits.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';

const NOT_SENT_TEXT = 'Not connected to the server, so the answer was not sent.';
const OPEN_CARD_SELECTOR = '.chat-card[data-resolved="false"]';

export interface AgentWaits {
  element: HTMLElement;
  sync(): void;
  isAsking(): boolean;
  answer(cardId: string, action: string, value: string): void;
  close(): void;
}

export function createAgentWaits(sessionId: string, showFailure: (failureText: string) => void): AgentWaits {
  const element = el('div', 'bs-card-approvals');
  const partElementById = new Map<string, HTMLElement>();
  const view: ChatWaitsView = {
    element,
    upsert: (parts) => {
      for (const part of parts) {
        if (part.kind !== 'card') continue;
        const rendered = renderStudioCard(part.card);
        if (rendered === null) continue;
        rendered.dataset.partId = part.id;
        const shown = partElementById.get(part.id);
        if (shown) shown.replaceWith(rendered);
        if (!shown) element.append(rendered);
        partElementById.set(part.id, rendered);
      }
    },
    remove: (partIds) => {
      for (const partId of partIds) {
        partElementById.get(partId)?.remove();
        partElementById.delete(partId);
      }
    },
    keepLogInPlace: (change) => change(),
    readDraft: () => '',
    readAttachments: () => [],
  };
  const waits = createChatWaits({
    sessionId,
    root: element,
    view: () => view,
    getApproval: () => chatApprovalOf(sessionId),
    getPlanGate: () => chatPlanGateOf(sessionId),
    showFailure: (failureText) => {
      if (failureText !== null) showFailure(failureText);
    },
    sendOrFail: (message) => {
      if (sendControlMsg(message)) return true;
      showFailure(NOT_SENT_TEXT);
      return false;
    },
  });
  const isAsking = () => element.querySelector(OPEN_CARD_SELECTOR) !== null;

  return {
    element,
    sync: () => {
      waits.sync();
      if (isAsking()) return;
      view.remove([...partElementById.keys()]);
    },
    isAsking,
    answer: (cardId, action, value) => {
      if (!isStudioCardAction(action)) return;
      waits.answerCard(cardId, action, value);
    },
    close: () => {
      waits.clearApproval();
      view.remove([...partElementById.keys()]);
    },
  };
}
