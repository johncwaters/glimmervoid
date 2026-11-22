import { UsageLimit, type ConversationApproval } from '#shared/contracts/session.ts';
import { API_KEY_PROMPT_KIND, LOGIN_PROMPT_KINDS, RATE_LIMIT_PROMPT_KIND, STATES } from '#shared/states.ts';
import { errorMessage } from '#shared/text.ts';
import { agentLabel } from '../arena/lineup-core.ts';
import { type sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { adoptElement, el, isRealInputOwningKey, releaseElement } from '../dom-helpers.ts';
import { openSwitchAccountDialog } from '../session-card/card-account.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { sendTerminalInput } from '../session-card/terminal-input.ts';
import { closeSessionPage } from '../page-registry.ts';
import { setSessionView } from '../ui-prefs.ts';
import { holdCardKeys, keyTargetOf } from './chat-cards.ts';
import type { ChatCard, ChatPart, SignInStage } from './chat-part.ts';
import { NO_ARRIVING_PARTS, type createChatView } from './chat-view.ts';

type ChatView = ReturnType<typeof createChatView>;
type SignInCard = Extract<ChatCard, { cardType: 'sign-in' }>;
type TerminalCardState = 'hidden' | 'borrowed' | 'released';

interface ShownApproval {
  approval: ConversationApproval;
  cards: ChatCard[];
  answers: Map<string, string>;
}

interface ChatWaitsOptions {
  sessionId: string;
  root: HTMLElement;
  view: () => ChatView;
  getApproval: () => ConversationApproval | null;
  showFailure: (failureText: string | null) => void;
  sendOrFail: (message: Parameters<typeof sendControlMsg>[0]) => boolean;
}

interface ChatWaits {
  isTerminalBorrowed(): boolean;
  pendingCardIds(): string[];
  sync(): void;
  releaseTerminal(): void;
  clearApproval(): void;
  restoreSignIn(): void;
  answerCard(cardId: string, action: string, value: string): void;
  handleKeydown(event: KeyboardEvent): void;
}

const NOT_SENT_TEXT = 'Not connected to the server, so the message was not sent.';
const WAKE_NOT_SET_TEXT = 'The wake at reset was not set.';
const LOGIN_COMMAND_BY_AGENT: Readonly<Record<string, string>> = { 'claude-code': '/login' };
const LOGIN_SUBMIT_DELAY_MS = 300;
const SIGNED_IN_STATES: ReadonlySet<string> = new Set([STATES.COMPLETE, STATES.IDLE]);

const ANSWERABLE_CARD_TYPES = ['question', 'permission', 'sign-in', 'usage-limit', 'live-terminal'] as const;
const ANSWERABLE_CARD_TYPE_MATCH = `:is(${ANSWERABLE_CARD_TYPES.map((cardType) => `[data-card-type="${cardType}"]`).join(', ')})`;
const OPEN_ANSWERABLE_CARD_SELECTOR = `.chat-card[data-resolved="false"][data-keys-ready]${ANSWERABLE_CARD_TYPE_MATCH}`;
const UNANSWERED_CARD_SELECTOR = `.chat-card[data-resolved="false"]${ANSWERABLE_CARD_TYPE_MATCH}`;
const UNANSWERED_QUESTION_CARD_SELECTOR = '.chat-card[data-card-type="question"][data-resolved="false"]';
const FOCUSABLE_CONTROL_SELECTOR = 'button, a[href], input, select, textarea, summary, [contenteditable="true"], [role="button"], [tabindex]:not([tabindex="-1"])';

export function cardPartOf(card: ChatCard): ChatPart {
  return { kind: 'card', id: card.cardId, card };
}

function approvalCardsOf(approval: ConversationApproval): ChatCard[] {
  const requestKey = `approval-${approval.requestId}`;
  if (approval.kind === 'permission') {
    const title = approval.toolName ? `Allow ${approval.toolName}?` : 'Allow this tool?';
    return [{ cardType: 'permission', cardId: requestKey, data: { title, detail: approval.summary }, resolution: null }];
  }
  const questions = approval.questions ?? [];
  const isStacked = questions.length > 1;
  return questions.map((question, index) => ({
    cardType: 'question',
    cardId: `${requestKey}-${index}`,
    data: { question: question.question, detail: question.header, ...(isStacked ? { step: `${index + 1} of ${questions.length}` } : {}), options: question.options.map((option) => ({ label: option.label, note: option.description })) },
    resolution: null,
  }));
}

function usageLimitOfActionValue(value: string): UsageLimit | null {
  const parsed = UsageLimit.safeParse(JSON.parse(value));
  return parsed.success ? parsed.data : null;
}

function isFocusOnOtherControl(): boolean {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement)) return false;
  if (focused.classList.contains('chat-composer-input')) return false;
  return focused.closest(FOCUSABLE_CONTROL_SELECTOR) !== null;
}

function isPlainEscapeKeydown(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented || event.repeat || event.isComposing) return false;
  return !(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey);
}

function isCardPickKeydown(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing) return false;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (isFocusOnOtherControl()) return false;
  return !isRealInputOwningKey(event);
}

function chatKeyTargetOf(root: HTMLElement, key: string): HTMLElement | null {
  const firstUnansweredCard = root.querySelector<HTMLElement>(UNANSWERED_CARD_SELECTOR);
  if (!firstUnansweredCard?.matches(OPEN_ANSWERABLE_CARD_SELECTOR)) return null;
  return keyTargetOf(firstUnansweredCard, key);
}

export function createChatWaits(options: ChatWaitsOptions): ChatWaits {
  const { sessionId, root, view, getApproval, showFailure, sendOrFail } = options;
  let shownApproval: ShownApproval | null = null;
  let terminalCardState: TerminalCardState = 'hidden';
  let terminalCardSerial = 0;
  let terminalCardId: string | null = null;
  let terminalHome: HTMLElement | null = null;
  let strayChildWatcher: MutationObserver | null = null;
  let signInCard: SignInCard | null = null;
  let signInCardSerial = 0;
  const cardIdsSettingLimitWake = new Set<string>();

  const releaseTerminal = () => {
    if (terminalCardState !== 'borrowed') return;
    terminalCardState = 'released';
    strayChildWatcher?.disconnect();
    strayChildWatcher = null;
    const ui = sessionUIs.get(sessionId);
    if (ui) releaseElement(ui.termWrap, ui.card);
    terminalHome?.remove();
    terminalHome = null;
    if (terminalCardId) view().remove([terminalCardId]);
    terminalCardId = null;
  };

  const sendStrayChildrenHome = (slot: HTMLElement, termWrap: HTMLElement) => {
    for (const child of [...slot.children]) {
      if (child !== termWrap) terminalHome?.before(child);
    }
  };

  const lendTerminalToCard = (cardId: string): boolean => {
    const ui = sessionUIs.get(sessionId);
    const slot = [...view().element.querySelectorAll<HTMLElement>('.chat-terminal-slot')].find((candidate) => candidate.closest<HTMLElement>('[data-part-id]')?.dataset.partId === cardId);
    if (!ui || !slot) return false;
    terminalCardState = 'borrowed';
    terminalHome = el('div', 'terminal-wrap-home');
    terminalHome.hidden = true;
    ui.termWrap.before(terminalHome);
    adoptElement(ui.termWrap, slot);
    strayChildWatcher = new MutationObserver(() => sendStrayChildrenHome(slot, ui.termWrap));
    strayChildWatcher.observe(slot, { childList: true });
    ui._ensureTerminalReady?.();
    return true;
  };

  const borrowTerminal = () => {
    if (terminalCardState === 'borrowed') return;
    const agent = sessionUIs.get(sessionId)?.agent;
    if (agent === undefined) return;
    terminalCardSerial += 1;
    const heading = `${agent === null ? 'The agent' : agentLabel(agent)} is waiting in its terminal`;
    const card: ChatCard = { cardType: 'live-terminal', cardId: `live-terminal-${terminalCardSerial}`, data: { heading }, resolution: null };
    view().upsert([cardPartOf(card)], new Set([card.cardId]));
    if (lendTerminalToCard(card.cardId)) terminalCardId = card.cardId;
  };

  const showSignInCard = (card: SignInCard) => {
    signInCard = card;
    view().upsert([cardPartOf(card)], new Set([card.cardId]));
  };

  const settleSignInCard = () => {
    const shownCard = signInCard;
    if (!shownCard) return;
    signInCard = null;
    if (shownCard.data.stage === 'signing-in') releaseTerminal();
    const sessionState = sessionUIs.get(sessionId)?.currentState;
    const hasSignedIn = shownCard.data.stage !== 'refused-key' && sessionState !== undefined && SIGNED_IN_STATES.has(sessionState);
    if (!hasSignedIn) {
      view().remove([shownCard.cardId]);
      return;
    }
    view().upsert([cardPartOf({ ...shownCard, resolution: { isSignedIn: true } })], NO_ARRIVING_PARTS);
  };

  const relendSignInTerminal = () => {
    if (signInCard?.data.stage !== 'signing-in' || terminalCardState === 'borrowed') return;
    lendTerminalToCard(signInCard.cardId);
  };

  const offerSignInCard = (loginKind: string) => {
    if (signInCard) {
      relendSignInTerminal();
      return;
    }
    const agent = sessionUIs.get(sessionId)?.agent ?? '';
    const stage: SignInStage = loginKind === API_KEY_PROMPT_KIND ? 'refused-key' : 'offered';
    releaseTerminal();
    signInCardSerial += 1;
    showSignInCard({ cardType: 'sign-in', cardId: `sign-in-${signInCardSerial}`, data: { agentName: agentLabel(agent), stage }, resolution: null });
  };

  const startSignIn = () => {
    const ui = sessionUIs.get(sessionId);
    const loginCommand = LOGIN_COMMAND_BY_AGENT[ui?.agent ?? ''];
    if (!signInCard || signInCard.data.stage !== 'offered' || !ui || !loginCommand) return;
    if (!sendTerminalInput(ui, loginCommand)) {
      showFailure(NOT_SENT_TEXT);
      return;
    }
    window.setTimeout(() => sendTerminalInput(ui, '\r'), LOGIN_SUBMIT_DELAY_MS);
    const signingInCard: SignInCard = { ...signInCard, data: { ...signInCard.data, stage: 'signing-in' } };
    view().keepLogInPlace(() => {
      showSignInCard(signingInCard);
      lendTerminalToCard(signingInCard.cardId);
    });
  };

  const loginKindOfSession = (): string | null => {
    const ui = sessionUIs.get(sessionId);
    const kind = ui?.pendingPromptKind ?? null;
    if (ui?.currentState !== STATES.WAITING || kind === null || !LOGIN_PROMPT_KINDS.has(kind)) return null;
    if (kind !== API_KEY_PROMPT_KIND && !LOGIN_COMMAND_BY_AGENT[ui.agent ?? '']) return null;
    return kind;
  };

  const settleShownApproval = () => {
    if (!shownApproval) return;
    const unanswered = shownApproval.cards.filter((card) => card.resolution === null).map((card) => card.cardId);
    view().remove(unanswered);
    shownApproval = null;
  };

  const sync = () => {
    const approval = getApproval();
    if (shownApproval && shownApproval.approval.requestId !== approval?.requestId) settleShownApproval();
    if (approval && !shownApproval) {
      shownApproval = { approval, cards: approvalCardsOf(approval), answers: new Map() };
      view().upsert(shownApproval.cards.map(cardPartOf), new Set(shownApproval.cards.map((card) => card.cardId)));
    }
    const isAnswerableFromChat = shownApproval !== null && shownApproval.cards.length > 0;
    const loginKind = isAnswerableFromChat ? null : loginKindOfSession();
    if (loginKind === null) settleSignInCard();
    if (loginKind !== null) {
      offerSignInCard(loginKind);
      return;
    }
    const ui = sessionUIs.get(sessionId);
    const isWaitingOnLimit = ui?.pendingPromptKind === RATE_LIMIT_PROMPT_KIND;
    const isWaitingOnTerminal = ui?.currentState === STATES.WAITING && !isAnswerableFromChat && !isWaitingOnLimit;
    if (isWaitingOnTerminal) {
      borrowTerminal();
      return;
    }
    releaseTerminal();
  };

  const resolveCard = (card: ChatCard) => {
    if (!shownApproval) return;
    shownApproval.cards = shownApproval.cards.map((shownCard) => (shownCard.cardId === card.cardId ? card : shownCard));
    view().upsert([cardPartOf(card)], NO_ARRIVING_PARTS);
  };

  const dismissShownQuestion = () => {
    const shown = shownApproval;
    if (shown?.approval.kind !== 'question') return;
    if (!sendOrFail({ type: 'decide-approval', id: sessionId, requestId: shown.approval.requestId, decision: 'deny' })) return;
    shown.answers.clear();
    for (const card of shown.cards) {
      if (card.cardType === 'question') resolveCard({ ...card, resolution: { isDismissed: true } });
    }
  };

  const dismissQuestionOnEscape = (event: KeyboardEvent): boolean => {
    if (!isPlainEscapeKeydown(event)) return false;
    const openQuestionCard = root.querySelector<HTMLElement>(UNANSWERED_QUESTION_CARD_SELECTOR);
    if (!openQuestionCard) return false;
    event.preventDefault();
    event.stopPropagation();
    if (openQuestionCard.dataset.keysReady !== undefined) dismissShownQuestion();
    return true;
  };

  const continueAtLimitReset = (cardId: string, value: string) => {
    const usageLimit = usageLimitOfActionValue(value);
    if (usageLimit === null || cardIdsSettingLimitWake.has(cardId)) return;
    cardIdsSettingLimitWake.add(cardId);
    sendControlRequest('wake-at-limit-reset', { id: sessionId })
      .finally(() => cardIdsSettingLimitWake.delete(cardId))
      .then((reply) => {
        if (reply.type !== 'wake-at-limit-reset-result' || !reply.ok) {
          showFailure(reply.type === 'wake-at-limit-reset-result' ? reply.error ?? WAKE_NOT_SET_TEXT : WAKE_NOT_SET_TEXT);
          return;
        }
        view().upsert([cardPartOf({ cardType: 'usage-limit', cardId, data: usageLimit, resolution: { isContinuingAtReset: true } })], NO_ARRIVING_PARTS);
      })
      .catch((error: unknown) => showFailure(errorMessage(error)));
  };

  const answerCard = (cardId: string, action: string, value: string) => {
    if (signInCard?.cardId === cardId && action === 'sign-in') {
      startSignIn();
      return;
    }
    if (action === 'open-terminal') {
      setSessionView('terminal');
      closeSessionPage();
      return;
    }
    if (action === 'switch-account') {
      openSwitchAccountDialog(sessionId);
      return;
    }
    if (action === 'continue-at-reset') {
      continueAtLimitReset(cardId, value);
      return;
    }
    const shown = shownApproval;
    const card = shown?.cards.find((shownCard) => shownCard.cardId === cardId);
    if (!shown || !card || card.resolution !== null) return;
    const { requestId } = shown.approval;
    if (card.cardType === 'permission' && action === 'decide' && (value === 'allow' || value === 'deny')) {
      if (!sendOrFail({ type: 'decide-approval', id: sessionId, requestId, decision: value })) return;
      resolveCard({ ...card, resolution: { decision: value } });
      return;
    }
    if (card.cardType === 'permission' && action === 'deny-with-message') {
      if (!sendOrFail({ type: 'decide-approval', id: sessionId, requestId, decision: 'deny', message: value })) return;
      resolveCard({ ...card, resolution: { decision: 'deny', message: value } });
      return;
    }
    if (card.cardType === 'question' && action === 'dismiss') {
      dismissShownQuestion();
      return;
    }
    if (card.cardType !== 'question' || action !== 'answer') return;
    shown.answers.set(card.data.question, value);
    if (shown.answers.size < shown.cards.length) {
      resolveCard({ ...card, resolution: { answer: value } });
      return;
    }
    if (!sendOrFail({ type: 'answer-approval', id: sessionId, requestId, answers: Object.fromEntries(shown.answers) })) {
      shown.answers.delete(card.data.question);
      return;
    }
    resolveCard({ ...card, resolution: { answer: value } });
  };

  const handleKeydown = (event: KeyboardEvent) => {
    if (dismissQuestionOnEscape(event)) return;
    if (!isCardPickKeydown(event)) return;
    if (view().readDraft() !== '' || view().readAttachments().length > 0) return;
    const keyTarget = chatKeyTargetOf(root, event.key);
    if (!keyTarget) return;
    event.preventDefault();
    event.stopPropagation();
    if (keyTarget instanceof HTMLInputElement) {
      keyTarget.focus();
      return;
    }
    keyTarget.click();
    root.querySelectorAll<HTMLElement>(OPEN_ANSWERABLE_CARD_SELECTOR).forEach(holdCardKeys);
  };

  return {
    isTerminalBorrowed: () => terminalCardState === 'borrowed',
    pendingCardIds: () => {
      const openCardIds = shownApproval?.cards.filter((card) => card.resolution === null).map((card) => card.cardId) ?? [];
      const terminalCardIds = [terminalCardId, signInCard?.cardId ?? null].filter((cardId): cardId is string => cardId !== null);
      return [...openCardIds, ...terminalCardIds];
    },
    sync,
    releaseTerminal,
    clearApproval: () => {
      shownApproval = null;
    },
    restoreSignIn: () => {
      if (signInCard) showSignInCard(signInCard);
    },
    answerCard,
    handleKeydown,
  };
}
