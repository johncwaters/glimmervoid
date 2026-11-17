import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import type { ChatCard, ChatCardType } from './chat-part.ts';

type ChatCardByType = { [Card in ChatCard as Card['cardType']]: Card };
type ChatCardRenderer<Type extends ChatCardType> = (card: ChatCardByType[Type]) => HTMLElement;
type ChatCardRendererTable = { [Type in ChatCardType]: ChatCardRenderer<Type> };

const DECISION_RECEIPT_BY_DECISION = { allow: 'Allowed', deny: 'Denied' } as const;

function dispatchCardAction(source: HTMLElement, card: ChatCard, action: string, value: string): void {
  const detail = { cardId: card.cardId, cardType: card.cardType, action, value };
  source.dispatchEvent(new CustomEvent('chat-card', { bubbles: true, composed: true, detail }));
}

function cardShell(card: ChatCard, heading: string): HTMLElement {
  const shell = el('section', 'chat-card');
  shell.dataset.cardType = card.cardType;
  shell.dataset.resolved = String(card.resolution !== null);
  shell.appendChild(el('div', 'chat-card-heading', heading));
  return shell;
}

function receipt(text: string): HTMLElement {
  return el('div', 'chat-card-receipt', text);
}

function renderPermissionCard(card: ChatCardByType['permission']): HTMLElement {
  const shell = cardShell(card, card.data.title);
  if (card.data.detail) shell.appendChild(el('pre', 'chat-card-detail', card.data.detail));
  if (card.resolution) {
    shell.appendChild(receipt(DECISION_RECEIPT_BY_DECISION[card.resolution.decision]));
    return shell;
  }
  const actions = el('div', 'chat-card-actions');
  actions.appendChild(button({ variant: 'primary', textCase: 'sentence', label: 'Allow', onClick: () => dispatchCardAction(shell, card, 'decide', 'allow') }));
  actions.appendChild(button({ variant: 'secondary', textCase: 'sentence', label: 'Deny', onClick: () => dispatchCardAction(shell, card, 'decide', 'deny') }));
  shell.appendChild(actions);
  return shell;
}

function renderQuestionCard(card: ChatCardByType['question']): HTMLElement {
  const shell = cardShell(card, card.data.question);
  if (card.data.detail) shell.appendChild(el('p', 'chat-card-text', card.data.detail));
  if (card.resolution) {
    shell.appendChild(receipt(`Answered: ${card.resolution.answer}`));
    return shell;
  }
  const options = el('div', 'chat-card-options');
  for (const option of card.data.options) {
    const optionRow = el('div', 'chat-card-option');
    optionRow.appendChild(button({ variant: 'secondary', textCase: 'sentence', label: option.label, onClick: () => dispatchCardAction(shell, card, 'answer', option.label) }));
    if (option.note) optionRow.appendChild(el('span', 'chat-card-option-note', option.note));
    options.appendChild(optionRow);
  }
  shell.appendChild(options);
  return shell;
}

function renderNoticeCard(card: ChatCardByType['notice']): HTMLElement {
  const shell = el('div', 'chat-card chat-notice', card.data.text);
  shell.dataset.cardType = card.cardType;
  return shell;
}

function renderLiveTerminalCard(card: ChatCardByType['live-terminal']): HTMLElement {
  const shell = cardShell(card, card.data.heading);
  shell.appendChild(el('div', 'chat-terminal-slot'));
  return shell;
}

const RENDERER_BY_CARD_TYPE = {
  permission: renderPermissionCard,
  question: renderQuestionCard,
  notice: renderNoticeCard,
  'live-terminal': renderLiveTerminalCard,
} satisfies ChatCardRendererTable;

const rendererByCardType: ChatCardRendererTable = RENDERER_BY_CARD_TYPE;

function renderCardOfType<Type extends ChatCardType>(cardType: Type, card: ChatCardByType[Type]): HTMLElement {
  return rendererByCardType[cardType](card);
}

export function renderCard(card: ChatCard): HTMLElement {
  return renderCardOfType(card.cardType, card);
}
