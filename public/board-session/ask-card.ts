import type { Board, BoardAsk } from '#shared/contracts/whiteboard.ts';
import type { Rect } from '#shared/whiteboard-layout-core.ts';
import { errorMessage } from '#shared/text.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { createLineIcon } from '../svg-dom.ts';
import { button } from '../ui/button.ts';
import type { Camera } from '../whiteboard/board-gl-renderer.ts';

const ANSWER_TIMEOUT_MS = 10000;
const CARD_GAP_PX = 8;
const SEND_ICON_PATH = 'M8 13V3M3.5 7.5L8 3l4.5 4.5';
const NOT_SENT_TEXT = 'The answer was not sent.';

interface ShownAsk {
  askBoxId: string;
  ask: BoardAsk;
}

export interface AskCards {
  element: HTMLElement;
  paint(boardId: string | null, asks: readonly ShownAsk[], boundsOf: (boxId: string) => Rect | null, camera: Camera): void;
}

export function asksOfSessions(board: Board | null, sessionIds: ReadonlySet<string>): ShownAsk[] {
  if (!board) return [];
  const asks: ShownAsk[] = [];
  for (const element of board.elements.values()) {
    if (element.kind !== 'box' || element.ask === null || !sessionIds.has(element.ask.sessionId)) continue;
    asks.push({ askBoxId: element.id, ask: element.ask });
  }
  return asks;
}

function createAskCard(boardId: string, shown: ShownAsk): HTMLElement {
  const element = el('form', 'bs-ask');
  element.setAttribute('aria-label', shown.ask.question);
  element.dataset.askBoxId = shown.askBoxId;
  const options = el('div', 'bs-ask-options');
  const answerInput = el('input', 'bs-ask-input');
  answerInput.type = 'text';
  answerInput.placeholder = 'Your answer';
  answerInput.setAttribute('aria-label', 'Your answer');
  const sendButton = button({ variant: 'primary-icon', size: 'small', label: 'Send answer', icon: createLineIcon(SEND_ICON_PATH, '1.8'), action: 'board-ask-send', disabled: true });
  sendButton.type = 'submit';
  const answerRow = el('div', 'bs-ask-row');
  answerRow.append(answerInput, sendButton);
  const failure = el('p', 'bs-ask-failure');
  failure.setAttribute('role', 'status');
  const optionButtons = shown.ask.options.map((option) => button({ variant: 'secondary', size: 'small', textCase: 'sentence', label: option, action: 'board-ask-option', onClick: () => sendAnswer(option) }));
  options.append(...optionButtons);
  element.append(options, answerRow, failure);
  options.hidden = optionButtons.length === 0;

  const setBusy = (isBusy: boolean) => {
    for (const optionButton of optionButtons) optionButton.disabled = isBusy;
    answerInput.disabled = isBusy;
    sendButton.disabled = isBusy || answerInput.value.trim().length === 0;
  };

  const sendAnswer = (answer: string) => {
    failure.textContent = '';
    setBusy(true);
    sendControlRequest('board-ask-answer', { boardId, askBoxId: shown.askBoxId, answer }, { timeoutMs: ANSWER_TIMEOUT_MS })
      .then((reply) => {
        setBusy(false);
        if (reply.type === 'board-ask-answer-result' && reply.ok) return;
        failure.textContent = reply.type === 'board-ask-answer-result' ? reply.error ?? NOT_SENT_TEXT : NOT_SENT_TEXT;
      })
      .catch((reason: unknown) => {
        setBusy(false);
        failure.textContent = `Could not confirm the answer was sent: ${errorMessage(reason)}`;
      });
  };

  answerInput.addEventListener('input', () => {
    sendButton.disabled = answerInput.value.trim().length === 0;
  });
  element.addEventListener('submit', (event) => {
    event.preventDefault();
    const answer = answerInput.value.trim();
    if (answer.length === 0) return;
    sendAnswer(answer);
  });
  element.addEventListener('pointerdown', (event) => event.stopPropagation());
  element.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });

  return element;
}

export function createAskCards(): AskCards {
  const element = el('div', 'bs-asks');
  const cardByKey = new Map<string, HTMLElement>();

  return {
    element,
    paint: (boardId, asks, boundsOf, camera) => {
      const shownKeys = new Set<string>();
      for (const shown of asks) {
        const rect = boundsOf(shown.askBoxId);
        if (boardId === null || rect === null) continue;
        const key = `${boardId}:${shown.askBoxId}`;
        shownKeys.add(key);
        const card = cardByKey.get(key) ?? createAskCard(boardId, shown);
        if (!cardByKey.has(key)) {
          cardByKey.set(key, card);
          element.append(card);
        }
        const left = (rect.x - camera.x) * camera.scale;
        const top = (rect.y + rect.height - camera.y) * camera.scale + CARD_GAP_PX;
        card.style.transform = `translate(${left}px, ${top}px)`;
      }
      for (const [key, card] of cardByKey) {
        if (shownKeys.has(key)) continue;
        card.remove();
        cardByKey.delete(key);
      }
    },
  };
}
