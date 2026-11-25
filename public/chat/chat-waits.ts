import { UsageLimit, type ConversationApproval } from '#shared/contracts/session.ts';
import type { PlanGate } from '#shared/contracts/plan-gate.ts';
import { API_KEY_PROMPT_KIND, LOGIN_COMMAND_BY_AGENT, LOGIN_PROMPT_KINDS, RATE_LIMIT_PROMPT_KIND, STATES } from '#shared/states.ts';
import { errorMessage } from '#shared/text.ts';
import { agentLabel } from '../arena/lineup-core.ts';
import { type sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { adoptElement, el, isRealInputOwningKey, releaseElement } from '../dom-helpers.ts';
import { openSwitchAccountDialog } from '../session-card/card-account.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { closeSessionPage } from '../page-registry.ts';
import { setSessionView } from '../ui-prefs.ts';
import { holdCardKeys, keyTargetOf } from './chat-cards.ts';
import type { ChatCard, ChatPart, PlanVerdict, SignInStage } from './chat-part.ts';
import { NO_ARRIVING_PARTS, type createChatView } from './chat-view.ts';

export type ChatWaitsView = Pick<ReturnType<typeof createChatView>, 'element' | 'upsert' | 'remove' | 'keepLogInPlace' | 'readDraft' | 'readAttachments'>;
type SignInCard = Extract<ChatCard, { cardType: 'sign-in' }>;
type PlanCard = Extract<ChatCard, { cardType: 'plan' }>;
type TerminalCardState = 'hidden' | 'borrowed' | 'released';

interface ShownApproval {
  approval: ConversationApproval;
  cards: ChatCard[];
  answers: ReadonlyMap<string, string>;
}

interface ApprovalStep {
  message: Record<string, unknown> | null;
  resolvedCards: ChatCard[];
  answers: ReadonlyMap<string, string>;
}

interface ChatWaitsOptions {
  sessionId: string;
  root: HTMLElement;
  view: () => ChatWaitsView;
  getApproval: () => ConversationApproval | null;
  getPlanGate: () => PlanGate | null;
  showFailure: (failureText: string | null) => void;
  sendOrFail: (message: Parameters<typeof sendControlMsg>[0]) => boolean;
}

interface ChatWaits {
  isTerminalBorrowed(): boolean;
  pendingCardIds(): string[];
  sync(): void;
  releaseTerminal(): void;
  clearApproval(): void;
  restoreCards(): void;
  answerCard(cardId: string, action: string, value: string): void;
  handleKeydown(event: KeyboardEvent): void;
}

const NOT_SENT_TEXT = 'Not connected to the server, so the message was not sent.';
const WAKE_NOT_SET_TEXT = 'The wake at reset was not set.';
const SIGN_IN_REQUEST_TIMEOUT_MS = 10000;
const SIGNED_IN_STATES: ReadonlySet<string> = new Set([STATES.COMPLETE, STATES.IDLE]);

const ANSWERABLE_CARD_TYPES = ['question', 'permission', 'plan', 'sign-in', 'usage-limit', 'live-terminal'] as const;
const PLAN_VERDICT_BY_ACTION: Readonly<Record<string, PlanVerdict>> = { 'plan-approve': 'approve', 'plan-reject': 'reject' };
const PLAN_VERDICT_BY_STATUS: Readonly<Record<PlanGate['status'], PlanVerdict | null>> = { pending: null, approved: 'approve', rejected: 'reject' };
const ANSWERABLE_CARD_TYPE_MATCH = `:is(${ANSWERABLE_CARD_TYPES.map((cardType) => `[data-card-type="${cardType}"]`).join(', ')})`;
const OPEN_ANSWERABLE_CARD_SELECTOR = `.chat-card[data-resolved="false"][data-keys-ready]${ANSWERABLE_CARD_TYPE_MATCH}`;
const UNANSWERED_CARD_SELECTOR = `.chat-card[data-resolved="false"]${ANSWERABLE_CARD_TYPE_MATCH}`;
const UNANSWERED_QUESTION_CARD_SELECTOR = '.chat-card[data-card-type="question"][data-resolved="false"]';
const FOCUSABLE_CONTROL_SELECTOR = 'button, a[href], input, select, textarea, summary, [contenteditable="true"], [role="button"], [tabindex]:not([tabindex="-1"])';

export function cardPartOf(card: ChatCard): ChatPart {
  return { kind: 'card', id: card.cardId, card };
}

function shownApprovalOf(approval: ConversationApproval): ShownApproval {
  return { approval, cards: approvalCardsOf(approval), answers: new Map() };
}

function dismissedQuestionsStep(sessionId: string, shown: ShownApproval): ApprovalStep {
  const resolvedCards = shown.cards.flatMap((card): ChatCard[] => card.cardType === 'question' ? [{ ...card, resolution: { isDismissed: true } }] : []);
  return { message: { type: 'decide-approval', id: sessionId, requestId: shown.approval.requestId, decision: 'deny' }, resolvedCards, answers: new Map() };
}

function reopenedQuestionStep(shown: ShownApproval, card: ChatCard): ApprovalStep | null {
  if (card.cardType !== 'question' || card.resolution === null || !('canChange' in card.resolution)) return null;
  const answers = new Map(shown.answers);
  answers.delete(card.data.question);
  return { message: null, resolvedCards: [{ ...card, resolution: null }], answers };
}

function answeredQuestionsStep(sessionId: string, shown: ShownApproval, card: Extract<ChatCard, { cardType: 'question' }>, value: string): ApprovalStep {
  const answers = new Map(shown.answers).set(card.data.question, value);
  if (answers.size < shown.cards.length) return { message: null, resolvedCards: [{ ...card, resolution: { answer: value, canChange: true } }], answers };
  const resolvedCards = shown.cards.flatMap((shownCard): ChatCard[] => shownCard.cardType === 'question' ? [{ ...shownCard, resolution: { answer: answers.get(shownCard.data.question) ?? value } }] : []);
  return { message: { type: 'answer-approval', id: sessionId, requestId: shown.approval.requestId, answers: Object.fromEntries(answers) }, resolvedCards, answers };
}

function approvalStepOf(sessionId: string, shown: ShownApproval, cardId: string, action: string, value: string): ApprovalStep | null {
  const card = shown.cards.find((shownCard) => shownCard.cardId === cardId);
  if (card && action === 'change') return reopenedQuestionStep(shown, card);
  if (!card || card.resolution !== null) return null;
  const { requestId } = shown.approval;
  if (card.cardType === 'permission' && action === 'decide' && (value === 'allow' || value === 'deny')) {
    return { message: { type: 'decide-approval', id: sessionId, requestId, decision: value }, resolvedCards: [{ ...card, resolution: { decision: value } }], answers: shown.answers };
  }
  if (card.cardType === 'permission' && action === 'deny-with-message') {
    return { message: { type: 'decide-approval', id: sessionId, requestId, decision: 'deny', message: value }, resolvedCards: [{ ...card, resolution: { decision: 'deny', message: value } }], answers: shown.answers };
  }
  if (card.cardType === 'question' && action === 'dismiss') return dismissedQuestionsStep(sessionId, shown);
  if (card.cardType !== 'question' || action !== 'answer') return null;
  return answeredQuestionsStep(sessionId, shown, card, value);
}

function isUnsentCard(card: ChatCard): boolean {
  return card.resolution === null || 'canChange' in card.resolution;
}

function withApprovalStep(shown: ShownApproval, step: ApprovalStep): ShownApproval {
  const resolvedById = new Map(step.resolvedCards.map((card) => [card.cardId, card]));
  return { ...shown, cards: shown.cards.map((card) => resolvedById.get(card.cardId) ?? card), answers: step.answers };
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
    data: { question: question.question, detail: question.header, ...(isStacked ? { step: `${index + 1} of ${questions.length}` } : {}), ...(question.multiSelect ? { multiSelect: true as const } : {}), options: question.options.map((option) => ({ label: option.label, note: option.description, ...(option.preview ? { preview: option.preview } : {}) })) },
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
  if (focused.dataset.toggle === 'true') return false;
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
  const { sessionId, root, view, getApproval, getPlanGate, showFailure, sendOrFail } = options;
  let shownApproval: ShownApproval | null = null;
  let terminalCardState: TerminalCardState = 'hidden';
  let terminalCardSerial = 0;
  let terminalCardId: string | null = null;
  let terminalHome: HTMLElement | null = null;
  let strayChildWatcher: MutationObserver | null = null;
  let signInCard: SignInCard | null = null;
  let planCard: PlanCard | null = null;
  let planCardSerial = 0;
  let isAwaitingPlanDecisionEcho = false;
  let signInCardSerial = 0;
  let isSignInRequestPending = false;
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
    if (!signInCard || signInCard.data.stage !== 'offered' || !ui || !loginCommand || isSignInRequestPending) return;
    const offeredCard = signInCard;
    isSignInRequestPending = true;
    sendControlRequest('sign-in-start', { id: sessionId }, { timeoutMs: SIGN_IN_REQUEST_TIMEOUT_MS })
      .finally(() => { isSignInRequestPending = false; })
      .then((reply) => {
        if (reply.type !== 'sign-in-start-result' || !reply.ok) {
          showFailure(reply.type === 'sign-in-start-result' ? reply.error ?? NOT_SENT_TEXT : NOT_SENT_TEXT);
          return;
        }
        if (signInCard !== offeredCard) return;
        showSigningInCard(offeredCard);
      })
      .catch(() => showFailure(NOT_SENT_TEXT));
  };

  const showSigningInCard = (offeredCard: SignInCard) => {
    const signingInCard: SignInCard = { ...offeredCard, data: { ...offeredCard.data, stage: 'signing-in' } };
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
    const unsent = shownApproval.cards.filter(isUnsentCard).map((card) => card.cardId);
    view().remove(unsent);
    shownApproval = null;
  };

  const showPlanCard = (card: PlanCard, arrivingIds: ReadonlySet<string>) => {
    planCard = card;
    view().upsert([cardPartOf(card)], arrivingIds);
  };

  const syncPlanCard = (planGate: PlanGate | null) => {
    if (planGate === null) {
      if (planCard?.resolution === null) view().remove([planCard.cardId]);
      planCard = null;
      isAwaitingPlanDecisionEcho = false;
      return;
    }
    const verdict = PLAN_VERDICT_BY_STATUS[planGate.status];
    if (verdict !== null) {
      isAwaitingPlanDecisionEcho = false;
      if (planCard?.resolution !== null || planCard.data.planText !== planGate.planText) return;
      showPlanCard({ ...planCard, resolution: { decision: verdict, feedback: planGate.feedback } }, NO_ARRIVING_PARTS);
      return;
    }
    if (isAwaitingPlanDecisionEcho) return;
    if (planCard?.resolution === null && planCard.data.planText === planGate.planText) return;
    if (planCard?.resolution === null) view().remove([planCard.cardId]);
    planCardSerial += 1;
    const agent = sessionUIs.get(sessionId)?.agent ?? null;
    const cardId = `plan-${planCardSerial}`;
    showPlanCard({ cardType: 'plan', cardId, data: { agentName: agent === null ? 'The agent' : agentLabel(agent), planText: planGate.planText, isPlanTruncated: planGate.isPlanTruncated }, resolution: null }, new Set([cardId]));
  };

  const decidePlan = (cardId: string, verdict: PlanVerdict, feedback: string) => {
    if (planCard?.cardId !== cardId || planCard.resolution !== null) return;
    if (!sendOrFail({ type: 'plan-decision', id: sessionId, decision: verdict, ...(feedback.length > 0 ? { feedback } : {}) })) return;
    isAwaitingPlanDecisionEcho = true;
    showPlanCard({ ...planCard, resolution: { decision: verdict, feedback: feedback.length > 0 ? feedback : null } }, NO_ARRIVING_PARTS);
  };

  const sync = () => {
    const approval = getApproval();
    if (shownApproval && shownApproval.approval.requestId !== approval?.requestId) settleShownApproval();
    if (approval && !shownApproval) {
      shownApproval = shownApprovalOf(approval);
      view().upsert(shownApproval.cards.map(cardPartOf), new Set(shownApproval.cards.map((card) => card.cardId)));
    }
    const planGate = getPlanGate();
    syncPlanCard(planGate);
    const isPlanPending = planGate?.status === 'pending';
    const isAnswerableFromChat = isPlanPending || (shownApproval !== null && shownApproval.cards.length > 0);
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

  const applyStep = (step: ApprovalStep | null) => {
    if (!shownApproval || step === null) return;
    if (step.message !== null && !sendOrFail(step.message)) return;
    shownApproval = withApprovalStep(shownApproval, step);
    view().upsert(step.resolvedCards.map(cardPartOf), NO_ARRIVING_PARTS);
  };

  const dismissShownQuestion = () => {
    const shown = shownApproval;
    if (shown?.approval.kind !== 'question') return;
    applyStep(dismissedQuestionsStep(sessionId, shown));
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
    const planVerdict = PLAN_VERDICT_BY_ACTION[action];
    if (planVerdict !== undefined) {
      decidePlan(cardId, planVerdict, value);
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
    if (!shownApproval) return;
    applyStep(approvalStepOf(sessionId, shownApproval, cardId, action, value));
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
    if (keyTarget.dataset.toggle === 'true') return;
    root.querySelectorAll<HTMLElement>(OPEN_ANSWERABLE_CARD_SELECTOR).forEach(holdCardKeys);
  };

  return {
    isTerminalBorrowed: () => terminalCardState === 'borrowed',
    pendingCardIds: () => {
      const openCardIds = shownApproval?.cards.filter((card) => card.resolution === null).map((card) => card.cardId) ?? [];
      const terminalCardIds = [terminalCardId, signInCard?.cardId ?? null, planCard?.resolution === null ? planCard.cardId : null].filter((cardId): cardId is string => cardId !== null);
      return [...openCardIds, ...terminalCardIds];
    },
    sync,
    releaseTerminal,
    clearApproval: () => {
      shownApproval = null;
    },
    restoreCards: () => {
      if (signInCard) showSignInCard(signInCard);
      if (planCard) showPlanCard(planCard, NO_ARRIVING_PARTS);
    },
    answerCard,
    handleKeydown,
  };
}
