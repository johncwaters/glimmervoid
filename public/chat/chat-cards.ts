import { CHAT_SEND_MAX_CHARS } from '#shared/contracts/control/session-messages.ts';
import { isRecommendedOptionLabel, withoutRecommendedSuffix } from '#shared/contracts/question-manager.ts';
import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import type { ChatCard, ChatCardType } from './chat-part.ts';

type ChatCardByType = { [Card in ChatCard as Card['cardType']]: Card };
type ChatCardRenderer<Type extends ChatCardType> = (card: ChatCardByType[Type]) => HTMLElement;
type ChatCardRendererTable = { [Type in ChatCardType]: ChatCardRenderer<Type> };

const DECISION_RECEIPT_BY_DECISION = { allow: 'Allowed', deny: 'Denied' } as const;
const ENTER_KEY = 'Enter';
const MAX_DIGIT_KEY = 9;

type ShownOption = { label: string; note: string; isRecommended: boolean };

const CARD_KEYS_READY_DELAY_MS = 500;

export function holdCardKeys(cardElement: HTMLElement): void {
  delete cardElement.dataset.keysReady;
  window.setTimeout(() => { cardElement.dataset.keysReady = 'true'; }, CARD_KEYS_READY_DELAY_MS);
}

function markCardKeys(element: HTMLElement, keys: readonly string[]): void {
  element.dataset.cardKeys = keys.join(' ');
}

function digitKeyOf(position: number): string | null {
  return position <= MAX_DIGIT_KEY ? String(position) : null;
}

function shownOptionsOf(options: readonly { label: string; note: string }[]): ShownOption[] {
  const recommendedOptions = options.filter((option) => isRecommendedOptionLabel(option.label));
  if (recommendedOptions.length !== 1) return options.map((option) => ({ ...option, isRecommended: false }));
  const [recommendedOption] = recommendedOptions;
  const otherOptions = options.filter((option) => option !== recommendedOption);
  return [{ ...recommendedOption, isRecommended: true }, ...otherOptions.map((option) => ({ ...option, isRecommended: false }))];
}

function dispatchCardAction(source: HTMLElement, card: ChatCard, action: string, value: string): void {
  const detail = { cardId: card.cardId, cardType: card.cardType, action, value };
  source.dispatchEvent(new CustomEvent('chat-card', { bubbles: true, composed: true, detail }));
}

function cardShell(card: ChatCard, heading: string): HTMLElement {
  const shell = el('section', 'chat-card');
  shell.dataset.cardType = card.cardType;
  shell.dataset.resolved = String(card.resolution !== null);
  if (card.resolution === null) holdCardKeys(shell);
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
    const decisionReceipt = DECISION_RECEIPT_BY_DECISION[card.resolution.decision];
    shell.appendChild(receipt(card.resolution.message ? `${decisionReceipt}: ${card.resolution.message}` : decisionReceipt));
    return shell;
  }
  const actions = el('div', 'chat-card-actions');
  const allowButton = button({ variant: 'primary', textCase: 'sentence', label: 'Allow', shortcutKey: '1', onClick: () => dispatchCardAction(shell, card, 'decide', 'allow') });
  const denyButton = button({ variant: 'secondary', textCase: 'sentence', label: 'Deny', shortcutKey: '2', onClick: () => dispatchCardAction(shell, card, 'decide', 'deny') });
  markCardKeys(allowButton, ['1']);
  markCardKeys(denyButton, ['2']);
  actions.append(allowButton, denyButton);
  shell.append(actions, denyMessageRowOf(shell, card));
  return shell;
}

function denyMessageRowOf(shell: HTMLElement, card: ChatCardByType['permission']): HTMLElement {
  const row = el('form', 'chat-card-deny-message');
  const messageInput = el('input', 'chat-card-message');
  messageInput.type = 'text';
  messageInput.maxLength = CHAT_SEND_MAX_CHARS;
  messageInput.placeholder = 'Tell the agent what to do instead';
  messageInput.setAttribute('aria-label', 'Message for the agent');
  messageInput.setAttribute('aria-keyshortcuts', '3');
  markCardKeys(messageInput, ['3']);
  const denyWithMessageButton = button({ variant: 'secondary', textCase: 'sentence', label: 'Deny with message', shortcutKey: '3', disabled: true });
  denyWithMessageButton.type = 'submit';
  messageInput.addEventListener('input', () => {
    denyWithMessageButton.disabled = messageInput.value.trim().length === 0;
  });
  row.addEventListener('submit', (event) => {
    event.preventDefault();
    const message = messageInput.value.trim();
    if (message.length === 0) return;
    dispatchCardAction(shell, card, 'deny-with-message', message);
  });
  row.append(messageInput, denyWithMessageButton);
  return row;
}

function renderQuestionCard(card: ChatCardByType['question']): HTMLElement {
  const shell = cardShell(card, card.data.question);
  if (card.data.detail) shell.appendChild(el('p', 'chat-card-text', card.data.detail));
  if (card.resolution) {
    shell.appendChild(receipt(`Answered: ${withoutRecommendedSuffix(card.resolution.answer)}`));
    return shell;
  }
  const options = el('div', 'chat-card-options');
  for (const [index, option] of shownOptionsOf(card.data.options).entries()) {
    options.appendChild(optionRowOf(shell, card, option, digitKeyOf(index + 1)));
  }
  shell.appendChild(options);
  return shell;
}

function optionRowOf(shell: HTMLElement, card: ChatCardByType['question'], option: ShownOption, digitKey: string | null): HTMLElement {
  const optionRow = el('div', 'chat-card-option');
  const shownKey = option.isRecommended ? ENTER_KEY : digitKey;
  const label = option.isRecommended ? withoutRecommendedSuffix(option.label) : option.label;
  const optionButton = button({
    variant: option.isRecommended ? 'primary' : 'secondary',
    textCase: 'sentence',
    label,
    ...(shownKey === null ? {} : { shortcutKey: shownKey }),
    onClick: () => dispatchCardAction(shell, card, 'answer', option.label),
  });
  if (option.isRecommended) optionButton.insertBefore(el('span', 'chat-card-recommended', 'Recommended'), optionButton.querySelector('.ui-button-shortcut'));
  markCardKeys(optionButton, [digitKey, option.isRecommended ? ENTER_KEY : null].filter((key): key is string => key !== null));
  optionRow.appendChild(optionButton);
  if (option.note) optionRow.appendChild(el('span', 'chat-card-option-note', option.note));
  return optionRow;
}

export function keyTargetOf(cardElement: HTMLElement, key: string): HTMLElement | null {
  const targets = cardElement.querySelectorAll<HTMLElement>('[data-card-keys]');
  return [...targets].find((target) => (target.dataset.cardKeys ?? '').split(' ').includes(key)) ?? null;
}

function renderNoticeCard(card: ChatCardByType['notice']): HTMLElement {
  const shell = el('div', 'chat-card chat-notice', card.data.text);
  shell.dataset.cardType = card.cardType;
  return shell;
}

function signInHeadingOf(card: ChatCardByType['sign-in']): string {
  if (card.resolution) return `Signed in to ${card.data.agentName}`;
  if (card.data.stage === 'refused-key') return `${card.data.agentName} refused its API key`;
  return `${card.data.agentName} needs you to sign in`;
}

const SIGN_IN_TEXT_BY_STAGE = {
  offered: 'Its login expired, so this turn stopped. Sign in, then resend your message.',
  'signing-in': 'Finish signing in below, then resend your message.',
  'refused-key': 'The API key this session started with no longer works. Replace it, then resend your message.',
} as const;

function renderSignInCard(card: ChatCardByType['sign-in']): HTMLElement {
  const shell = cardShell(card, signInHeadingOf(card));
  if (card.resolution) return shell;
  shell.appendChild(el('p', 'chat-card-text', SIGN_IN_TEXT_BY_STAGE[card.data.stage]));
  if (card.data.stage === 'signing-in') {
    shell.appendChild(el('div', 'chat-terminal-slot'));
    return shell;
  }
  if (card.data.stage === 'refused-key') return shell;
  const actions = el('div', 'chat-card-actions');
  const signInButton = button({ variant: 'primary', textCase: 'sentence', label: 'Sign in', shortcutKey: '1', onClick: () => dispatchCardAction(shell, card, 'sign-in', '') });
  markCardKeys(signInButton, ['1']);
  actions.appendChild(signInButton);
  shell.appendChild(actions);
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
  'sign-in': renderSignInCard,
} satisfies ChatCardRendererTable;

const rendererByCardType: ChatCardRendererTable = RENDERER_BY_CARD_TYPE;

function renderCardOfType<Type extends ChatCardType>(cardType: Type, card: ChatCardByType[Type]): HTMLElement {
  return rendererByCardType[cardType](card);
}

export function renderCard(card: ChatCard): HTMLElement {
  return renderCardOfType(card.cardType, card);
}
