import { isStudioCardAction, renderStudioCard } from '../chat/chat-cards.ts';
import { chatApprovalOf, chatPlanGateOf } from '../chat/chat-page.ts';
import { createChatWaits } from '../chat/chat-waits.ts';
import type { ChatWaitsView } from '../chat/chat-waits.ts';
import { el } from '../dom-helpers.ts';
import answerApprovalAction from '../state/actions/answer-approval.ts';
import decideApprovalAction from '../state/actions/decide-approval.ts';
import planDecisionAction from '../state/actions/plan-decision.ts';
import type { ActionResult } from '../state/define-action.ts';
import {
  NOT_SENT_TEXT,
  OPEN_CARD_SELECTOR,
  classifyWaitsOutgoingMessage,
} from './agent-waits-core.ts';
import type { WaitsActionDispatch } from './agent-waits-core.ts';

export interface AgentWaits {
  element: HTMLElement;
  sync(): void;
  isAsking(): boolean;
  answer(cardId: string, action: string, value: string): void;
  close(): void;
}

function runWaitsAction(dispatch: WaitsActionDispatch): Promise<ActionResult> {
  if (dispatch.kind === 'decide-approval') return decideApprovalAction(dispatch.input);
  if (dispatch.kind === 'answer-approval') return answerApprovalAction(dispatch.input);
  return planDecisionAction(dispatch.input);
}

export function createAgentWaits(sessionId: string, showFailure: (failureText: string) => void): AgentWaits {
  const element = el('div', 'bs-card-approvals');
  const partElementById = new Map<string, HTMLElement>();
  let isClosed = false;
  let isResettingPlanGate = false;

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
    getPlanGate: () => (isResettingPlanGate ? null : chatPlanGateOf(sessionId)),
    showFailure: (failureText) => {
      if (!isClosed && failureText !== null) showFailure(failureText);
    },
    sendOrFail: (message) => {
      const dispatch = classifyWaitsOutgoingMessage(message);
      if (dispatch === null) {
        if (!isClosed) showFailure(NOT_SENT_TEXT);
        return false;
      }
      void runWaitsAction(dispatch).then((outcome) => {
        if (isClosed || outcome.ok) return;
        rollbackFailedDispatch(dispatch.kind);
        showFailure(outcome.error.message || NOT_SENT_TEXT);
      });
      return true;
    },
  });
  const isAsking = () => element.querySelector(OPEN_CARD_SELECTOR) !== null;
  const sync = () => {
    if (isClosed) return;
    waits.sync();
    if (isAsking()) return;
    view.remove([...partElementById.keys()]);
  };
  const rollbackFailedDispatch = (kind: WaitsActionDispatch['kind']) => {
    if (kind === 'plan-decision') {
      isResettingPlanGate = true;
      waits.sync();
      isResettingPlanGate = false;
      sync();
      return;
    }
    waits.clearApproval();
    sync();
  };

  return {
    element,
    sync,
    isAsking,
    answer: (cardId, action, value) => {
      if (isClosed || !isStudioCardAction(action)) return;
      waits.answerCard(cardId, action, value);
    },
    close: () => {
      isClosed = true;
      waits.clearApproval();
      view.remove([...partElementById.keys()]);
    },
  };
}
