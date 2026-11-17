import { el } from '../dom-helpers.ts';
import { mountContentsDiff } from '../review/diff-view.ts';
import { CHECK_ICON_PATH, CLOSE_ICON_PATH, createLineIcon } from '../svg-dom.ts';
import type { ChatPart, ChatToolCall, ChatToolOutcome } from './chat-part.ts';
import { groupSummaryOf, isVisibleFailure, type OutputExcerpt } from './tool-call-core.ts';

type CallState = 'running' | 'ok' | 'failed' | 'no-result';

const STATUS_LABEL_BY_STATE: Record<CallState, string> = {
  running: 'running',
  ok: 'done',
  failed: 'failed',
  'no-result': 'no result',
};

function callStateOf(outcome: ChatToolOutcome, isShownAsFailure: boolean): CallState {
  if (outcome.status !== 'done') return outcome.status;
  return outcome.isError && isShownAsFailure ? 'failed' : 'ok';
}

function statusMark(state: CallState): HTMLElement {
  const mark = el('span', 'chat-call-mark');
  mark.dataset.state = state;
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', STATUS_LABEL_BY_STATE[state]);
  if (state === 'ok') mark.appendChild(createLineIcon(CHECK_ICON_PATH, '1.5'));
  if (state === 'failed') mark.appendChild(createLineIcon(CLOSE_ICON_PATH, '1.5'));
  return mark;
}

function callRow(tag: 'div' | 'summary', verb: string, target: string, state: CallState): HTMLElement {
  const row = el(tag, 'chat-call-row');
  row.dataset.state = state;
  row.appendChild(el('span', 'chat-call-verb', verb));
  if (target) row.appendChild(el('span', 'chat-call-target', target));
  row.appendChild(statusMark(state));
  return row;
}

function excerptElement(excerpt: OutputExcerpt): HTMLElement {
  const element = el('div', 'chat-call-excerpt');
  element.appendChild(el('div', 'chat-call-excerpt-line', excerpt.firstLine));
  if (excerpt.hiddenLineCount > 0) element.appendChild(el('div', 'chat-call-excerpt-gap', `+ ${excerpt.hiddenLineCount} lines`));
  if (excerpt.lastLine !== null) element.appendChild(el('div', 'chat-call-excerpt-line', excerpt.lastLine));
  return element;
}

function mountDiffOnFirstOpen(details: HTMLDetailsElement, edit: NonNullable<ChatToolCall['edit']>): HTMLElement {
  const diffHost = el('div', 'chat-call-diff');
  let hasRequestedDiff = false;
  details.addEventListener('toggle', () => {
    if (!details.open || hasRequestedDiff) return;
    hasRequestedDiff = true;
    mountContentsDiff(diffHost, edit.filePath, { oldContents: edit.oldText, newContents: edit.newText }, 'unified').catch((error: unknown) => {
      hasRequestedDiff = false;
      diffHost.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  return diffHost;
}

function expandableCall(call: ChatToolCall, state: CallState, body: (details: HTMLDetailsElement) => HTMLElement): HTMLElement {
  const details = el('details', 'chat-call');
  details.dataset.openKey = call.toolUseId;
  details.appendChild(callRow('summary', call.verb, call.target, state));
  details.appendChild(body(details));
  return details;
}

function renderCall(call: ChatToolCall, state: CallState): HTMLElement {
  const { edit, excerpt } = call;
  if (edit) return expandableCall(call, state, (details) => mountDiffOnFirstOpen(details, edit));
  if (excerpt) return expandableCall(call, state, () => excerptElement(excerpt));
  return callRow('div', call.verb, call.target, state);
}

function groupStateOf(calls: readonly ChatToolCall[], callStates: readonly CallState[]): CallState {
  if (callStates.includes('running')) return 'running';
  if (callStates.includes('failed')) return 'failed';
  return calls.every((call) => call.outcome.status === 'no-result') ? 'no-result' : 'ok';
}

function lastFailureExcerpt(calls: readonly ChatToolCall[], callStates: readonly CallState[]): HTMLElement | null {
  const lastCall = calls[calls.length - 1];
  if (!lastCall?.excerpt || callStates[calls.length - 1] !== 'failed') return null;
  const excerpt = excerptElement(lastCall.excerpt);
  excerpt.classList.add('chat-tools-failure');
  return excerpt;
}

export function renderToolGroup(part: Extract<ChatPart, { kind: 'tools' }>): HTMLElement {
  const callStates = part.calls.map((call, callIndex) => callStateOf(call.outcome, isVisibleFailure(part.calls, callIndex)));
  const group = el('div', 'chat-tools');
  const failureExcerpt = lastFailureExcerpt(part.calls, callStates);
  const onlyCall = part.calls.length === 1 ? part.calls[0] : undefined;
  if (onlyCall && failureExcerpt) {
    group.append(onlyCall.edit ? renderCall(onlyCall, 'failed') : callRow('div', onlyCall.verb, onlyCall.target, 'failed'), failureExcerpt);
    return group;
  }
  if (onlyCall) {
    group.appendChild(renderCall(onlyCall, callStates[0] ?? 'running'));
    return group;
  }
  const details = el('details', 'chat-tools-group');
  details.dataset.openKey = part.id;
  details.appendChild(callRow('summary', groupSummaryOf(part.calls), '', groupStateOf(part.calls, callStates)));
  const callList = el('div', 'chat-tools-calls');
  callList.append(...part.calls.map((call, callIndex) => renderCall(call, callStates[callIndex] ?? 'running')));
  details.appendChild(callList);
  group.appendChild(details);
  if (failureExcerpt) group.appendChild(failureExcerpt);
  return group;
}
