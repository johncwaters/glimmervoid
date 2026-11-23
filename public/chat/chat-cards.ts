import { CHAT_SEND_MAX_CHARS } from '#shared/contracts/control/session-messages.ts';
import { isRecommendedOptionLabel, withoutRecommendedSuffix } from '#shared/contracts/question-manager.ts';
import { twoUnitDurationText } from '#shared/display-text.ts';
import { clock } from '#shared/clock.ts';
import { el } from '../dom-helpers.ts';
import { resetClockText } from '../usage-limit-text.ts';
import { shortcutHint } from '../shortcuts-core.ts';
import { SHORTCUT_PLATFORM } from '../shortcuts.ts';
import { BOARDS_ICON_PATH, createLineIcon } from '../svg-dom.ts';
import { button } from '../ui/button.ts';
import { keycap } from '../ui/keycap.ts';
import { createPressable } from '../ui/pressable.ts';
import type { ChatCard, ChatCardType } from './chat-part.ts';

type ChatCardByType = { [Card in ChatCard as Card['cardType']]: Card };
type ChatCardRenderer<Type extends ChatCardType> = (card: ChatCardByType[Type]) => HTMLElement;
type ChatCardRendererTable = { [Type in ChatCardType]: ChatCardRenderer<Type> };

const DECISION_RECEIPT_BY_DECISION = { allow: 'Allowed', deny: 'Denied' } as const;
const ENTER_KEY = 'Enter';
const MAX_DIGIT_KEY = 9;

type ShownOption = { label: string; note: string; preview?: string; isRecommended: boolean };

const CARD_KEYS_READY_DELAY_MS = 500;

const keysReadyTimerByElement = new WeakMap<HTMLElement, number>();

function releaseCardKeys(cardElement: HTMLElement): void {
  window.clearTimeout(keysReadyTimerByElement.get(cardElement));
  keysReadyTimerByElement.delete(cardElement);
  delete cardElement.dataset.keysReady;
}

export function holdCardKeys(cardElement: HTMLElement): void {
  releaseCardKeys(cardElement);
  keysReadyTimerByElement.set(cardElement, window.setTimeout(() => { cardElement.dataset.keysReady = 'true'; }, CARD_KEYS_READY_DELAY_MS));
}

function markCardKeys(element: HTMLElement, keys: readonly string[]): void {
  element.dataset.cardKeys = keys.join(' ');
}

function digitKeyOf(position: number): string | null {
  return position <= MAX_DIGIT_KEY ? String(position) : null;
}

function shownOptionsOf(options: readonly { label: string; note: string; preview?: string }[]): ShownOption[] {
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

function shellOf(cardType: string, heading: string, isResolved: boolean): HTMLElement {
  const shell = el('section', 'chat-card');
  shell.dataset.cardType = cardType;
  shell.dataset.resolved = String(isResolved);
  if (!isResolved) holdCardKeys(shell);
  shell.appendChild(el('div', 'chat-card-heading', heading));
  return shell;
}

function cardShell(card: ChatCard, heading: string): HTMLElement {
  return shellOf(card.cardType, heading, card.resolution !== null);
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

export interface QuestionCardModel {
  readonly cardType: string;
  readonly heading: string;
  readonly detail: string;
  readonly step?: string;
  readonly options: readonly { label: string; note: string; preview?: string }[];
  readonly answer: string | null;
  readonly canChangeAnswer: boolean;
  readonly isDismissed: boolean;
}

interface QuestionCardActions {
  readonly onAnswer: (label: string) => void;
  readonly onChange: () => void;
}

const ESCAPE_KEY = 'Escape';

function dismissFootOf(onDismiss: () => void): HTMLElement {
  const foot = el('div', 'chat-card-foot');
  const dismissButton = button({ variant: 'quiet', size: 'small', textCase: 'inline', label: 'Dismiss', shortcutKey: 'Esc', onClick: onDismiss });
  dismissButton.setAttribute('aria-keyshortcuts', ESCAPE_KEY);
  markCardKeys(dismissButton, [ESCAPE_KEY]);
  foot.append(dismissButton);
  return foot;
}

function answerReceiptOf(answer: string, canChangeAnswer: boolean, onChange: () => void): HTMLElement {
  const row = el('div', 'chat-card-answer-row');
  row.append(receipt(`Answered: ${withoutRecommendedSuffix(answer)}`));
  if (canChangeAnswer) row.append(button({ variant: 'quiet', size: 'small', textCase: 'inline', label: 'Change', onClick: onChange }));
  return row;
}

function questionMetaLineOf(question: QuestionCardModel): HTMLElement | null {
  if (!question.detail && !question.step) return null;
  const metaLine = el('div', 'chat-card-meta');
  if (question.detail) metaLine.appendChild(el('span', 'chat-card-topic', question.detail));
  if (question.step) metaLine.appendChild(el('span', 'chat-card-step', question.step));
  return metaLine;
}

export function questionCardOf(question: QuestionCardModel, actions: QuestionCardActions, foot: HTMLElement): HTMLElement {
  const shell = shellOf(question.cardType, question.heading, question.answer !== null || question.isDismissed);
  const metaLine = questionMetaLineOf(question);
  if (metaLine) shell.prepend(metaLine);
  if (question.isDismissed) {
    shell.appendChild(receipt('Dismissed'));
    return shell;
  }
  if (question.answer !== null) {
    shell.appendChild(answerReceiptOf(question.answer, question.canChangeAnswer, actions.onChange));
    return shell;
  }
  const options = el('div', 'chat-card-options');
  for (const [index, option] of shownOptionsOf(question.options).entries()) {
    options.appendChild(optionRowOf(option, digitKeyOf(index + 1), actions.onAnswer));
  }
  shell.append(options, foot);
  return shell;
}

function renderQuestionCard(card: ChatCardByType['question']): HTMLElement {
  const { resolution } = card;
  const question = {
    cardType: card.cardType,
    heading: card.data.question,
    detail: card.data.detail,
    ...(card.data.step ? { step: card.data.step } : {}),
    options: card.data.options,
    answer: resolution !== null && 'answer' in resolution ? resolution.answer : null,
    canChangeAnswer: resolution !== null && 'canChange' in resolution,
    isDismissed: resolution !== null && 'isDismissed' in resolution,
  };
  const shell: HTMLElement = questionCardOf(question, {
    onAnswer: (label) => dispatchCardAction(shell, card, 'answer', label),
    onChange: () => dispatchCardAction(shell, card, 'change', ''),
  }, dismissFootOf(() => dispatchCardAction(shell, card, 'dismiss', '')));
  return shell;
}

function optionRowOf(option: ShownOption, digitKey: string | null, onAnswer: (label: string) => void): HTMLElement {
  const optionRow = createPressable('chat-card-option');
  optionRow.dataset.recommended = String(option.isRecommended);
  const shownKey = option.isRecommended ? ENTER_KEY : digitKey;
  const label = option.isRecommended ? withoutRecommendedSuffix(option.label) : option.label;
  const keys = el('span', 'chat-card-option-keys');
  if (option.isRecommended) keys.appendChild(el('span', 'chat-card-recommended', 'Recommended'));
  if (shownKey !== null) keys.appendChild(keycap(shownKey, { tone: option.isRecommended ? 'accent' : 'neutral' }));
  optionRow.append(el('span', 'chat-card-option-label', label), keys);
  if (option.note) optionRow.appendChild(el('span', 'chat-card-option-note', option.note));
  if (option.preview) optionRow.appendChild(el('pre', 'chat-card-option-preview', option.preview));
  const answerKeys = [digitKey, option.isRecommended ? ENTER_KEY : null].filter((key): key is string => key !== null);
  if (answerKeys.length > 0) optionRow.setAttribute('aria-keyshortcuts', answerKeys.join(' '));
  markCardKeys(optionRow, answerKeys);
  optionRow.addEventListener('click', () => onAnswer(option.label));
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

function boardChangeTextOf(card: ChatCardByType['board-change']): HTMLElement {
  const summary = el('span', 'chat-board-change-summary');
  summary.append('Changed ', el('strong', null, card.data.changed));
  if (card.data.boardTitle !== null) summary.append(' on ', el('strong', null, card.data.boardTitle));
  const text = el('span', 'chat-board-change-text');
  text.append(el('span', 'chat-board-change-eyebrow', 'Board updated'), summary);
  return text;
}

function renderBoardChangeCard(card: ChatCardByType['board-change']): HTMLElement {
  const row = el('section', 'chat-board-change');
  row.dataset.cardType = card.cardType;
  const showOnBoard = button({ variant: 'primary', size: 'small', textCase: 'inline', label: 'Show on board', shortcutKey: shortcutHint('show-board-change', SHORTCUT_PLATFORM), onClick: () => dispatchCardAction(row, card, 'focus', '') });
  const icon = createLineIcon(BOARDS_ICON_PATH, '1.5');
  icon.classList.add('chat-board-change-icon');
  row.append(icon, boardChangeTextOf(card), showOnBoard);
  return row;
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
  const openTerminalButton = button({ variant: 'secondary', textCase: 'sentence', label: 'Open Terminal', shortcutKey: '1', onClick: () => dispatchCardAction(shell, card, 'open-terminal', '') });
  markCardKeys(openTerminalButton, ['1']);
  const actions = el('div', 'chat-card-actions');
  actions.append(openTerminalButton);
  shell.append(el('p', 'chat-card-text', 'It is showing something Glimmervoid cannot read. Answer it here.'), el('div', 'chat-terminal-slot'), actions);
  return shell;
}

const MS_PER_SECOND = 1000;
const LIMIT_COUNTDOWN_SELECTOR = '.chat-limit-countdown';

const USAGE_LIMIT_HEADING_BY_WINDOW: Readonly<Record<string, string>> = {
  weekly: 'Weekly limit reached',
  session: 'Session limit reached',
};

function usageLimitHeadingOf(card: ChatCardByType['usage-limit']): string {
  return USAGE_LIMIT_HEADING_BY_WINDOW[card.data.window] ?? 'Usage limit reached';
}

function limitCountdownText(resetsAtMs: number, nowMs: number): string {
  const secondsLeft = Math.ceil((resetsAtMs - nowMs) / MS_PER_SECOND);
  if (secondsLeft <= 0) return 'now';
  return `in ${twoUnitDurationText(secondsLeft, { smallestUnit: 'm', dropsZeroRemainder: true })}`;
}

export function refreshLimitCountdowns(root: ParentNode, nowMs: number): void {
  for (const countdown of root.querySelectorAll<HTMLElement>(LIMIT_COUNTDOWN_SELECTOR)) {
    countdown.textContent = limitCountdownText(Number(countdown.dataset.resetsAtMs), nowMs);
  }
}

function usageLimitReceiptOf(card: ChatCardByType['usage-limit']): string {
  const resetClock = resetClockText(card.data.resetsAtMs);
  if (card.resolution && 'isContinuingAtReset' in card.resolution) return `Continues at ${resetClock}.`;
  return `Resets at ${resetClock}.`;
}

function renderUsageLimitCard(card: ChatCardByType['usage-limit']): HTMLElement {
  const shell = cardShell(card, usageLimitHeadingOf(card));
  if (card.resolution) {
    shell.appendChild(receipt(usageLimitReceiptOf(card)));
    return shell;
  }
  const countdown = el('span', 'chat-limit-countdown', limitCountdownText(card.data.resetsAtMs, clock.nowMs()));
  countdown.dataset.resetsAtMs = String(card.data.resetsAtMs);
  const text = el('p', 'chat-card-text');
  text.append(`This turn stopped. It resets at ${resetClockText(card.data.resetsAtMs)}, `, countdown, '.');
  const actions = el('div', 'chat-card-actions');
  const switchAccountButton = button({ variant: 'secondary', textCase: 'sentence', label: 'Switch account', shortcutKey: '1', onClick: () => dispatchCardAction(shell, card, 'switch-account', JSON.stringify(card.data)) });
  const continueButton = button({ variant: 'primary', textCase: 'sentence', label: 'Continue at reset', shortcutKey: '2', onClick: () => dispatchCardAction(shell, card, 'continue-at-reset', JSON.stringify(card.data)) });
  markCardKeys(switchAccountButton, ['1']);
  markCardKeys(continueButton, ['2']);
  actions.append(switchAccountButton, continueButton);
  shell.append(text, actions);
  return shell;
}

const RENDERER_BY_CARD_TYPE = {
  permission: renderPermissionCard,
  question: renderQuestionCard,
  notice: renderNoticeCard,
  'board-change': renderBoardChangeCard,
  'live-terminal': renderLiveTerminalCard,
  'sign-in': renderSignInCard,
  'usage-limit': renderUsageLimitCard,
} satisfies ChatCardRendererTable;

const rendererByCardType: ChatCardRendererTable = RENDERER_BY_CARD_TYPE;

function renderCardOfType<Type extends ChatCardType>(cardType: Type, card: ChatCardByType[Type]): HTMLElement {
  return rendererByCardType[cardType](card);
}

export function renderCard(card: ChatCard): HTMLElement {
  return renderCardOfType(card.cardType, card);
}
