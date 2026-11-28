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
  NOT_SENT_TEXT,
  OPEN_CARD_SELECTOR,
  classifyWaitsOutgoingMessage,
} from './agent-waits-core.ts';
import type { WaitsActionDispatch } from './agent-waits-core.ts';

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
  const resetPlanSignal = createSyncedSignal(false);
  const generationSignal = createSyncedSignal(0);
  const isClosedSignal = createSyncedSignal(false);

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
    getPlanGate: () => (resetPlanSignal.peek() ? null : chatPlanGateOf(sessionId)),
    showFailure: (failureText) => {
      if (!isClosedSignal.peek() && failureText !== null) showFailure(failureText);
    },
    sendOrFail: (message) => {
      const dispatch = classifyWaitsOutgoingMessage(message);
      if (dispatch === null) {
        if (!isClosedSignal.peek()) showFailure(NOT_SENT_TEXT);
        return false;
      }
      const dispatchGeneration = generationSignal.peek();
      onFlush(() => {
        void runWaitsAction(dispatch).then((outcome) => {
          if (generationSignal.peek() !== dispatchGeneration || outcome.ok) return;
          rollbackFailedDispatch(dispatch.kind);
          showFailure(outcome.error.message || NOT_SENT_TEXT);
        });
      });
      return true;
    },
  });

  const isAsking = () => elementsSignal.peek().some(isRenderedCardOpen);

  const sync = () => {
    isClosedSignal.update(false);
    waits.sync();
    if (isAsking()) return;
    view.remove([...partElementById.keys()]);
  };

  const rollbackFailedDispatch = (kind: WaitsActionDispatch['kind']) => {
    if (kind === 'plan-decision') {
      resetPlanSignal.update(true);
      waits.sync();
      resetPlanSignal.update(false);
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
      isClosedSignal.update(true);
      generationSignal.update((count) => count + 1);
      resetPlanSignal.update(true);
      waits.sync();
      resetPlanSignal.update(false);
      waits.clearApproval();
      view.remove([...partElementById.keys()]);
    },
  };
}

export function AgentWaits(props: AgentWaitsProps): JSX.Element {
  const hostRef = bindWaitsHost(() => props.waits.elements());
  return <div class="bs-card-approvals" ref={hostRef} />;
}
