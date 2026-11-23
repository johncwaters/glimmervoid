import type { OpenBoardAsk } from '#shared/contracts/control/board-session-messages.ts';
import { errorMessage } from '#shared/text.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { questionCardOf } from '../chat/chat-cards.ts';
import type { QuestionCardModel } from '../chat/chat-cards.ts';
import { withoutRecommendedSuffix } from '#shared/contracts/question-manager.ts';
import { CHAT_SEND_MAX_CHARS } from '#shared/contracts/control/session-messages.ts';
import type { Camera } from '../whiteboard/board-gl-renderer.ts';

const ANSWER_TIMEOUT_MS = 10000;
const BOARD_QUESTION_TOPIC = 'Board question';
const CARD_RING_COVER = 5;
const NOT_SENT_TEXT = 'The answer was not sent.';

export interface AskCards {
  element: HTMLElement;
  paint(boardId: string | null, asks: readonly OpenBoardAsk[], camera: Camera): OpenBoardAsk[];
}

export function asksOfSessions(openAsks: readonly OpenBoardAsk[], sessionIds: ReadonlySet<string>): OpenBoardAsk[] {
  return openAsks.filter((shown) => sessionIds.has(shown.ask.sessionId));
}

function answerFormOf(onSubmit: (answer: string) => void): { form: HTMLFormElement; answerInput: HTMLInputElement; sendButton: HTMLButtonElement; failure: HTMLElement } {
  const form = el('form', 'bs-ask-foot');
  const answerInput = el('input', 'chat-card-message');
  answerInput.type = 'text';
  answerInput.maxLength = CHAT_SEND_MAX_CHARS;
  answerInput.placeholder = 'Your answer';
  answerInput.setAttribute('aria-label', 'Your answer');
  const sendButton = button({ variant: 'secondary', textCase: 'sentence', label: 'Send answer', action: 'board-ask-send', disabled: true });
  sendButton.type = 'submit';
  const answerRow = el('div', 'bs-ask-row');
  answerRow.append(answerInput, sendButton);
  const failure = el('p', 'bs-ask-failure');
  failure.setAttribute('role', 'status');
  form.append(answerRow, failure);
  answerInput.addEventListener('input', () => {
    sendButton.disabled = answerInput.value.trim().length === 0;
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const answer = answerInput.value.trim();
    if (answer.length === 0) return;
    onSubmit(answer);
  });
  return { form, answerInput, sendButton, failure };
}

function createAskCard(boardId: string, shown: OpenBoardAsk): HTMLElement {
  const element = el('div', 'bs-ask');
  element.dataset.askBoxId = shown.askBoxId;
  const answerForm = answerFormOf((answer) => sendAnswer(answer));
  const question: QuestionCardModel = {
    cardType: 'question',
    heading: shown.ask.question,
    detail: BOARD_QUESTION_TOPIC,
    options: shown.ask.options.map((option) => ({ label: option, note: '' })),
    answer: null,
    canChangeAnswer: false,
    isDismissed: false,
  };
  const card = questionCardOf(question, { onAnswer: (label) => sendAnswer(withoutRecommendedSuffix(label)), onChange: () => {} }, answerForm.form);
  card.setAttribute('aria-label', shown.ask.question);
  element.append(card);

  const setBusy = (isBusy: boolean) => {
    for (const optionButton of card.querySelectorAll<HTMLButtonElement>('.chat-card-option')) optionButton.disabled = isBusy;
    answerForm.answerInput.disabled = isBusy;
    answerForm.sendButton.disabled = isBusy || answerForm.answerInput.value.trim().length === 0;
  };

  const sendAnswer = (answer: string) => {
    answerForm.failure.textContent = '';
    setBusy(true);
    sendControlRequest('board-ask-answer', { boardId, askBoxId: shown.askBoxId, answer }, { timeoutMs: ANSWER_TIMEOUT_MS })
      .then((reply) => {
        setBusy(false);
        if (reply.type === 'board-ask-answer-result' && reply.ok) return;
        answerForm.failure.textContent = reply.type === 'board-ask-answer-result' ? reply.error ?? NOT_SENT_TEXT : NOT_SENT_TEXT;
      })
      .catch((reason: unknown) => {
        setBusy(false);
        answerForm.failure.textContent = `Could not confirm the answer was sent: ${errorMessage(reason)}`;
      });
  };

  element.addEventListener('pointerdown', (event) => event.stopPropagation());
  element.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });

  return element;
}

export function createAskCards(): AskCards {
  const element = el('div', 'bs-asks');
  const cardByKey = new Map<string, HTMLElement>();

  return {
    element,
    paint: (boardId, asks, camera) => {
      const shownKeys = new Set<string>();
      const newAsks: OpenBoardAsk[] = [];
      for (const shown of asks) {
        const { rect } = shown;
        if (boardId === null) continue;
        const key = `${boardId}:${shown.askBoxId}`;
        shownKeys.add(key);
        const card = cardByKey.get(key) ?? createAskCard(boardId, shown);
        if (!cardByKey.has(key)) {
          newAsks.push(shown);
          cardByKey.set(key, card);
          element.append(card);
        }
        const left = (rect.x - CARD_RING_COVER - camera.x) * camera.scale;
        const top = (rect.y - CARD_RING_COVER - camera.y) * camera.scale;
        card.style.width = `${rect.width + CARD_RING_COVER * 2}px`;
        card.style.height = `${rect.height + CARD_RING_COVER * 2}px`;
        card.style.transform = `translate(${left}px, ${top}px) scale(${camera.scale})`;
      }
      for (const [key, card] of cardByKey) {
        if (shownKeys.has(key)) continue;
        card.remove();
        cardByKey.delete(key);
      }
      return newAsks;
    },
  };
}
