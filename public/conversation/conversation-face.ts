import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { ConversationApproval, ConversationApprovalDecision } from '#shared/contracts/session.ts';
import type { TraceRecord } from '#shared/contracts/trace.ts';
import { STATES } from '#shared/states.ts';
import { answerWithOptionKeystrokes, approveKeystrokes, rejectAndInstructKeystrokes, isAnyPromptShowing } from '../calm/permission-keys-core.ts';
import type { TimedKeystroke } from '../calm/permission-keys-core.ts';
import { el } from '../dom-helpers.ts';
import { parsePlanMarkdown } from '../plan/plan-markdown-core.ts';
import { renderPlanBlocks } from '../plan/plan-render.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { findSessionUi } from '../session-card/card-registry.ts';
import { sendTerminalInput } from '../session-card/terminal.ts';
import {
  composerKeystrokes,
  conversationEntries,
  interruptKeystrokes,
  isWorkGroupRunning,
  trimResidentRecords,
  workGroupHeadline,
} from './conversation-core.ts';
import type { ConversationEntry, ConversationFaceController, ConversationWorkGroup } from './conversation-core.ts';

type TraceReply = ServerMessageOf<'session-trace-response'>;

const REQUEST_ID_PREFIX = 'conversation:';
const REQUEST_TIMEOUT_MS = 10_000;
const STICK_TO_BOTTOM_PX = 48;
const MAX_TOOL_OUTPUT_CHARS = 4000;

interface ConversationFaceDeps {
  signal?: AbortSignal;
  sendControl: (message: Record<string, unknown>) => boolean;
  showTerminal: () => void;
}

interface PendingTraceRequest {
  requestId: string;
  after: number | null;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

let nextRequestNumber = 1;

function sendKeystrokePlan(sessionId: string, ui: SessionUi, steps: readonly TimedKeystroke[], onDone: (isSent: boolean) => void, stepIndex = 0) {
  const step = steps[stepIndex];
  if (!step) { onDone(true); return; }
  setTimeout(() => {
    if (findSessionUi(sessionId) !== ui) { onDone(false); return; }
    if (!sendTerminalInput(ui, step.data)) { onDone(false); return; }
    sendKeystrokePlan(sessionId, ui, steps, onDone, stepIndex + 1);
  }, step.delayBeforeMs);
}

function untimed(steps: readonly { data: string }[] | null): TimedKeystroke[] | null {
  return steps ? steps.map((step) => ({ data: step.data, delayBeforeMs: 0 })) : null;
}

export function createConversationFace({ signal, sendControl, showTerminal }: ConversationFaceDeps): ConversationFaceController {
  const root = el('div', 'conversation-face');
  root.hidden = true;
  const log = el('div', 'conversation-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  const emptyNote = el('p', 'conversation-empty', 'No conversation yet. Messages appear here as the agent works.');
  const approvalSlot = el('div', 'conversation-approval');
  approvalSlot.hidden = true;
  const bridgeNote = el('p', 'conversation-bridge-note', 'Restart this Codex session to connect it to the conversation view. Until then, use the terminal.');
  bridgeNote.hidden = true;
  const composer = el('form', 'conversation-composer');
  const input = el('textarea', 'conversation-input');
  input.rows = 2;
  input.placeholder = 'Message the agent';
  input.setAttribute('aria-label', 'Message the agent');
  const composerActions = el('div', 'conversation-composer-actions');
  const status = el('span', 'conversation-status');
  status.setAttribute('role', 'status');
  const stopButton = el('button', 'conversation-stop', 'Stop');
  stopButton.type = 'button';
  stopButton.title = 'Interrupt the current turn (Esc)';
  const terminalButton = el('button', 'conversation-terminal', 'Terminal');
  terminalButton.type = 'button';
  const sendButton = el('button', 'conversation-send', 'Send');
  sendButton.type = 'submit';
  composerActions.append(status, terminalButton, stopButton, sendButton);
  composer.append(input, composerActions);
  root.append(log, bridgeNote, approvalSlot, composer);

  let sessionId: string | null = null;
  let records: TraceRecord[] = [];
  let nextOffset = 0;
  let hasLoadedOnce = false;
  let pendingRequest: PendingTraceRequest | null = null;
  let isRefreshOwed = false;
  const expandedGroupKeys = new Set<string>();

  function currentUi(): SessionUi | null {
    return sessionId ? findSessionUi(sessionId) ?? null : null;
  }

  function setStatus(text: string) {
    status.textContent = text;
  }

  function clearPendingRequest() {
    if (pendingRequest) clearTimeout(pendingRequest.timeoutHandle);
    pendingRequest = null;
  }

  function requestRecords() {
    if (!sessionId || root.hidden) return;
    if (pendingRequest) { isRefreshOwed = true; return; }
    const requestId = `${REQUEST_ID_PREFIX}${nextRequestNumber++}`;
    const after = hasLoadedOnce ? nextOffset : null;
    const message = after === null
      ? { type: 'session-trace', id: sessionId, requestId, endingAt: 'tail' }
      : { type: 'session-trace', id: sessionId, requestId, after };
    if (!sendControl(message)) { setStatus('Conversation unavailable while disconnected.'); return; }
    isRefreshOwed = false;
    pendingRequest = {
      requestId,
      after,
      timeoutHandle: setTimeout(() => { pendingRequest = null; requestRecords(); }, REQUEST_TIMEOUT_MS),
    };
  }

  function isNearBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight <= STICK_TO_BOTTOM_PX;
  }

  function renderMessage(entry: Extract<ConversationEntry, { kind: 'user' | 'assistant' | 'notice' }>) {
    const bubble = el('article', `conversation-message conversation-${entry.kind}`);
    if (entry.kind === 'assistant') {
      bubble.append(renderPlanBlocks(parsePlanMarkdown(entry.text)));
      return bubble;
    }
    bubble.append(el('p', 'conversation-text', entry.text));
    return bubble;
  }

  function renderWorkGroup(group: ConversationWorkGroup) {
    const details = el('details', 'conversation-work');
    details.open = expandedGroupKeys.has(group.key);
    details.addEventListener('toggle', () => {
      if (details.open) { expandedGroupKeys.add(group.key); return; }
      expandedGroupKeys.delete(group.key);
    });
    const summary = el('summary', 'conversation-work-summary', workGroupHeadline(group) || 'Working');
    if (isWorkGroupRunning(group)) summary.classList.add('is-running');
    if (group.errorCount > 0) summary.classList.add('has-error');
    details.append(summary);
    const steps = el('ol', 'conversation-steps');
    for (const step of group.steps) {
      const item = el('li', 'conversation-step');
      if (step.isError) item.classList.add('has-error');
      const line = el('div', 'conversation-step-line');
      line.append(el('span', 'conversation-step-tool', step.name), el('span', 'conversation-step-summary', step.summary));
      item.append(line);
      if (step.output) item.append(el('pre', 'conversation-step-output', step.output.slice(0, MAX_TOOL_OUTPUT_CHARS)));
      steps.append(item);
    }
    details.append(steps);
    return details;
  }

  function renderLog() {
    const shouldStick = isNearBottom();
    const entries = conversationEntries(records);
    const nodes = entries.map((entry) => (entry.kind === 'work' ? renderWorkGroup(entry) : renderMessage(entry)));
    log.replaceChildren(...(nodes.length > 0 ? nodes : [emptyNote]));
    if (shouldStick) log.scrollTop = log.scrollHeight;
  }

  function sendPlan(steps: readonly TimedKeystroke[] | null, sentText: string) {
    const ui = currentUi();
    if (!ui || !sessionId || !steps) { setStatus('Unable to reach this session.'); return; }
    sendKeystrokePlan(sessionId, ui, steps, (isSent) => setStatus(isSent ? sentText : 'Unable to reach this session.'));
  }

  function answerCodexApproval(approval: ConversationApproval, decision: ConversationApprovalDecision) {
    if (!sessionId) return;
    const isSent = sendControl({ type: 'conversation-approval', id: sessionId, requestId: approval.requestId, decision });
    setStatus(isSent ? 'Answer sent.' : 'Unable to send the answer while disconnected.');
  }

  function approvalButton(label: string, onClick: () => void) {
    const button = el('button', 'conversation-approval-action', label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }

  function renderCodexApproval(approval: ConversationApproval) {
    const kindLabel = { command: 'Run command?', fileChange: 'Apply file changes?', permissions: 'Grant permissions?' }[approval.kind];
    approvalSlot.append(
      el('p', 'conversation-approval-title', kindLabel),
      el('pre', 'conversation-approval-summary', approval.summary),
    );
    const actions = el('div', 'conversation-approval-actions');
    if (approval.isSummaryTruncated) {
      approvalSlot.append(el('p', 'conversation-approval-note', 'This request is too long to show here. Read the full request in the terminal before approving it there.'));
      actions.append(approvalButton('Decline', () => answerCodexApproval(approval, 'decline')));
      approvalSlot.append(actions);
      return;
    }
    actions.append(
      approvalButton('Approve', () => answerCodexApproval(approval, 'accept')),
      approvalButton('Approve for session', () => answerCodexApproval(approval, 'acceptForSession')),
      approvalButton('Decline', () => answerCodexApproval(approval, 'decline')),
    );
    approvalSlot.append(actions);
  }

  function renderClaudePrompt(ui: SessionUi) {
    const detail = ui.pendingPromptDetail;
    const question = detail?.question ?? null;
    approvalSlot.append(el('p', 'conversation-approval-title', question ? 'The agent asks' : 'Permission requested'));
    if (detail?.summary) approvalSlot.append(el('pre', 'conversation-approval-summary', question ? question.text : `${detail.toolName}: ${detail.summary}`));
    const actions = el('div', 'conversation-approval-actions');
    if (question && !question.multiSelect) {
      question.options.forEach((option, optionIndex) => {
        actions.append(approvalButton(option, () => sendPlan(untimed(answerWithOptionKeystrokes(ui.agent, optionIndex, question.options.length, false)), 'Answer sent.')));
      });
      approvalSlot.append(actions);
      return;
    }
    if (ui.pendingPromptKind === 'permission' && !question) {
      actions.append(
        approvalButton('Approve', () => sendPlan(untimed(approveKeystrokes(ui.agent)), 'Approved.')),
        approvalButton('Decline', () => sendPlan(untimed(rejectAndInstructKeystrokes(ui.agent, '')?.dismissPrompt ?? null), 'Declined.')),
      );
      approvalSlot.append(actions);
      return;
    }
    approvalSlot.append(el('p', 'conversation-approval-note', 'Answer this prompt in the terminal.'));
  }

  function renderApproval() {
    const ui = currentUi();
    approvalSlot.replaceChildren();
    const codexApproval = ui?.conversationApproval ?? null;
    const isPromptShowing = ui ? isAnyPromptShowing(ui.currentState, ui.pendingPromptKind) : false;
    const isAwaitingBridge = ui?.agent === 'codex' && !ui.hasConversationBridge;
    bridgeNote.hidden = !isAwaitingBridge;
    approvalSlot.hidden = !codexApproval && !isPromptShowing;
    sendButton.disabled = !approvalSlot.hidden || isAwaitingBridge;
    if (!ui) return;
    if (codexApproval) { renderCodexApproval(codexApproval); return; }
    if (!isPromptShowing) return;
    if (ui.agent === 'claude-code') { renderClaudePrompt(ui); return; }
    approvalSlot.append(el('p', 'conversation-approval-note', 'The agent is waiting on a prompt. Answer it in the terminal.'));
  }

  function renderControls() {
    const ui = currentUi();
    stopButton.disabled = ui?.currentState !== STATES.RUNNING;
  }

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    if (sendButton.disabled) return;
    const ui = currentUi();
    const steps = composerKeystrokes(ui?.agent, input.value);
    if (!steps) return;
    input.value = '';
    sendPlan(steps, 'Sent.');
  }, { signal });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    composer.requestSubmit();
  }, { signal });
  stopButton.addEventListener('click', () => sendPlan(interruptKeystrokes(currentUi()?.agent), 'Interrupt sent.'), { signal });
  terminalButton.addEventListener('click', () => showTerminal(), { signal });

  function show(id: string) {
    if (sessionId !== id) {
      sessionId = id;
      records = [];
      nextOffset = 0;
      hasLoadedOnce = false;
      expandedGroupKeys.clear();
      clearPendingRequest();
      setStatus('');
    }
    root.hidden = false;
    renderLog();
    refresh();
    requestRecords();
  }

  function hide() {
    root.hidden = true;
    clearPendingRequest();
  }

  function refresh() {
    if (root.hidden) return;
    renderApproval();
    renderControls();
  }

  function applyTraceResponse(reply: TraceReply): boolean {
    if (!pendingRequest || reply.requestId !== pendingRequest.requestId) return false;
    const answeredRequest = pendingRequest;
    clearPendingRequest();
    if (reply.id !== sessionId) return true;
    const isContiguous = answeredRequest.after !== null && reply.start === answeredRequest.after && !reply.reset;
    if (answeredRequest.after !== null && !isContiguous) {
      hasLoadedOnce = false;
      records = [];
      requestRecords();
      return true;
    }
    records = trimResidentRecords(answeredRequest.after === null ? [...reply.records] : [...records, ...reply.records]);
    nextOffset = reply.next;
    hasLoadedOnce = true;
    renderLog();
    if (isRefreshOwed) requestRecords();
    return true;
  }

  function applyTraceChanged(id: string) {
    if (id !== sessionId || root.hidden) return;
    requestRecords();
  }

  return { el: root, show, hide, refresh, applyTraceResponse, applyTraceChanged };
}
