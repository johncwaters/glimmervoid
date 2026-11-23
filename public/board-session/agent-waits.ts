import { renderCard } from '../chat/chat-cards.ts';
import { chatApprovalOf } from '../chat/chat-page.ts';
import { createChatWaits } from '../chat/chat-waits.ts';
import type { ChatWaitsView } from '../chat/chat-waits.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';

const NOT_SENT_TEXT = 'Not connected to the server, so the answer was not sent.';
const OPEN_CARD_SELECTOR = '.chat-card[data-resolved="false"]';
const TERMINAL_WAIT_TEXT = 'It is waiting on something only its terminal shows, and Studio cannot show that terminal yet.';

export interface AgentWaits {
  element: HTMLElement;
  sync(): void;
  isAsking(): boolean;
  answer(cardId: string, action: string, value: string): void;
  close(): void;
}

function showTerminalWaitText(rendered: HTMLElement): void {
  const text = rendered.querySelector('.chat-card-text');
  if (text) text.textContent = TERMINAL_WAIT_TEXT;
  const slot = rendered.querySelector<HTMLElement>('.chat-terminal-slot');
  if (slot) slot.hidden = true;
}

export function createAgentWaits(sessionId: string, showFailure: (failureText: string) => void): AgentWaits {
  const element = el('div', 'bs-card-approvals');
  const partElementById = new Map<string, HTMLElement>();
  const view: ChatWaitsView = {
    element,
    upsert: (parts) => {
      for (const part of parts) {
        if (part.kind !== 'card') continue;
        const rendered = renderCard(part.card);
        rendered.dataset.partId = part.id;
        if (part.card.cardType === 'live-terminal') showTerminalWaitText(rendered);
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
    answer: waits.answerCard,
    close: () => {
      waits.releaseTerminal();
      waits.clearApproval();
      view.remove([...partElementById.keys()]);
    },
  };
}
