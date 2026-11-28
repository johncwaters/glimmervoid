import { createEffect, onFlush } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { isStudioCardAction, renderStudioCard } from '../chat/chat-cards.ts';
import { chatApprovalOf, chatPlanGateOf } from '../chat/chat-page.ts';
import { createChatWaits } from '../chat/chat-waits.ts';
import type { ChatWaitsView } from '../chat/chat-waits.ts';
import answerApprovalAction from '../state/actions/answer-approval.ts';
import decideApprovalAction from '../state/actions/decide-approval.ts';
import planDecisionAction from '../state/actions/plan-decision.ts';
import type { ActionResult } from '../state/define-action.ts';
import { createSyncedSignal } from '../ui/store-signal.ts';
import {
  INITIAL_AGENT_WAITS_STATE,
  OPEN_CARD_SELECTOR,
  beginWaitsSync,
  closeWaitsState,
  decideWaitsDispatchSettled,
  decideWaitsFailureDisplay,
  decideWaitsOutgoingDispatch,
  shouldExposePlanGate,
  withPlanGateReset,
} from './agent-waits-core.ts';
import type { AgentWaitsState, WaitsActionDispatch, WaitsRollbackKind } from './agent-waits-core.ts';

export interface AgentWaits {
  elements(): readonly HTMLElement[];
  sync(): void;
  isAsking(): boolean;
  answer(cardId: string, action: string, value: string): void;
  close(): void;
}

interface AgentWaitsProps {
  waits: AgentWaits;
}

function runWaitsAction(dispatch: WaitsActionDispatch): Promise<ActionResult> {
  if (dispatch.kind === 'decide-approval') return decideApprovalAction(dispatch.input);
  if (dispatch.kind === 'answer-approval') return answerApprovalAction(dispatch.input);
  return planDecisionAction(dispatch.input);
}

function isRenderedCardOpen(element: HTMLElement): boolean {
  return element.matches(OPEN_CARD_SELECTOR) || element.querySelector(OPEN_CARD_SELECTOR) !== null;
}

function syncWaitsHostChildren(host: HTMLElement, nextElements: readonly HTMLElement[]): void {
  const nextSet = new Set<Element>(nextElements);
  for (const child of [...host.children]) {
    if (!nextSet.has(child)) child.remove();
  }
  let cursor = host.firstElementChild;
  for (const nextChild of nextElements) {
    if (cursor === nextChild) {
      cursor = cursor.nextElementSibling;
      continue;
    }
    host.insertBefore(nextChild, cursor);
  }
}

function bindWaitsHost(readElements: () => readonly HTMLElement[]): (element: HTMLDivElement) => void {
  let hostElement: HTMLDivElement | undefined;
  createEffect(
    () => readElements(),
    (elements) => {
      if (hostElement) syncWaitsHostChildren(hostElement, elements);
    },
  );
  return (element) => {
    hostElement = element;
    syncWaitsHostChildren(element, readElements());
  };
}

export function createAgentWaitsHandle(sessionId: string, showFailure: (failureText: string) => void): AgentWaits {
  const hostElement = document.createElement('div');
  const partElementById = new Map<string, HTMLElement>();
  const elementsSignal = createSyncedSignal<readonly HTMLElement[]>([]);
  const stateSignal = createSyncedSignal<AgentWaitsState>(INITIAL_AGENT_WAITS_STATE);

  const publishElements = () => {
    elementsSignal.update([...partElementById.values()]);
  };

  const view: ChatWaitsView = {
    element: hostElement,
    upsert: (parts) => {
      for (const part of parts) {
        if (part.kind !== 'card') continue;
        const rendered = renderStudioCard(part.card);
        if (rendered === null) continue;
        rendered.dataset.partId = part.id;
        partElementById.set(part.id, rendered);
      }
      publishElements();
    },
    remove: (partIds) => {
      for (const partId of partIds) partElementById.delete(partId);
      publishElements();
    },
    keepLogInPlace: (change) => change(),
    readDraft: () => '',
    readAttachments: () => [],
  };

  const waits = createChatWaits({
    sessionId,
    root: hostElement,
    view: () => view,
    getApproval: () => chatApprovalOf(sessionId),
    getPlanGate: () => (shouldExposePlanGate(stateSignal.peek()) ? chatPlanGateOf(sessionId) : null),
    showFailure: (failureText) => {
      const decision = decideWaitsFailureDisplay(stateSignal.peek(), failureText);
      if (decision.shouldShow && decision.message !== null) showFailure(decision.message);
    },
    sendOrFail: (message) => {
      const started = decideWaitsOutgoingDispatch(stateSignal.peek(), message);
      if (started.dispatch === null) {
        if (started.shouldShowFailure && started.failureText !== null) showFailure(started.failureText);
        return false;
      }
      const dispatch = started.dispatch;
      onFlush(() => {
        void runWaitsAction(dispatch).then((outcome) => {
          const settled = decideWaitsDispatchSettled(
            stateSignal.peek(),
            dispatch.kind,
            started.generation,
            outcome.ok,
            outcome.ok ? null : outcome.error.message,
          );
          applyRollback(settled.rollback);
          if (settled.shouldShowFailure && settled.failureText !== null) showFailure(settled.failureText);
        });
      });
      return true;
    },
  });

  const isAsking = () => elementsSignal.peek().some(isRenderedCardOpen);

  const sync = () => {
    stateSignal.update(beginWaitsSync);
    waits.sync();
    if (isAsking()) return;
    view.remove([...partElementById.keys()]);
  };

  const resetPlanCard = () => {
    stateSignal.update((previous) => withPlanGateReset(previous, true));
    waits.sync();
    stateSignal.update((previous) => withPlanGateReset(previous, false));
  };

  const applyRollback = (rollback: WaitsRollbackKind) => {
    if (rollback === 'none') return;
    if (rollback === 'reset-plan') {
      resetPlanCard();
      sync();
      return;
    }
    waits.clearApproval();
    sync();
  };

  return {
    elements: () => elementsSignal.read(),
    sync,
    isAsking,
    answer: (cardId, action, value) => {
      if (!isStudioCardAction(action)) return;
      waits.answerCard(cardId, action, value);
    },
    close: () => {
      stateSignal.update(closeWaitsState);
      resetPlanCard();
      waits.clearApproval();
      view.remove([...partElementById.keys()]);
    },
  };
}

export function AgentWaits(props: AgentWaitsProps): JSX.Element {
  const hostRef = bindWaitsHost(() => props.waits.elements());
  return <div class="bs-card-approvals" ref={hostRef} />;
}
