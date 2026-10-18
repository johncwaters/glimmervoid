import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { ConversationAnswers, ConversationApproval, ConversationApprovalDecision, ConversationQuestion } from '#shared/contracts/session.ts';
import type { TraceRecord } from '#shared/contracts/trace.ts';
import { STATES } from '#shared/states.ts';
import { el } from '../dom-helpers.ts';
import { isPhoneLayout } from '../form-factor.ts';
import { parsePlanMarkdown } from '../plan/plan-markdown-core.ts';
import { renderPlanBlocks } from '../plan/plan-render.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { findSessionUi } from '../session-card/card-registry.ts';
import { sendTerminalInput } from '../session-card/terminal.ts';
import { uploadFileToSession } from '../session-upload.ts';
import {
  composerKeystrokes,
  conversationEntries,
  interruptKeystrokes,
  isAnyPromptShowing,
  isWorkGroupRunning,
  submitKeystrokes,
  trimResidentRecords,
  workGroupHeadline,
} from './conversation-core.ts';
import type { ConversationEntry, ConversationFaceController, ConversationWorkGroup, TimedKeystroke } from './conversation-core.ts';

type TraceReply = ServerMessageOf<'session-trace-response'>;

const REQUEST_ID_PREFIX = 'conversation:';
const REQUEST_TIMEOUT_MS = 10_000;
const STICK_TO_BOTTOM_PX = 48;
const MULTI_SELECT_ANSWER_SEPARATOR = ', ';
const ATTACH_GLYPH = '+';
const STOP_GLYPH = String.fromCharCode(0x25a0);
const SEND_GLYPH = String.fromCharCode(0x2191);
const CODEX_APPROVAL_TITLES: Readonly<Record<string, string>> = { command: 'Run command?', fileChange: 'Apply file changes?', permissions: 'Grant permissions?' };

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

function composerIconButton(className: string, glyph: string, actionName: string) {
  const button = el('button', `conversation-icon-button ${className}`, glyph);
  button.type = 'button';
  button.title = actionName;
  button.setAttribute('aria-label', actionName);
  return button;
}

type KeystrokePlanOutcome = 'sent' | 'unreachable' | 'stopped-by-prompt';

function isPromptBlockingInput(ui: SessionUi): boolean {
  return ui.conversationApproval !== null || isAnyPromptShowing(ui.currentState, ui.pendingPromptKind);
}

function sendKeystrokePlan(sessionId: string, ui: SessionUi, steps: readonly TimedKeystroke[], onDone: (outcome: KeystrokePlanOutcome) => void, stepIndex = 0) {
  const step = steps[stepIndex];
  if (!step) { onDone('sent'); return; }
  setTimeout(() => {
    if (findSessionUi(sessionId) !== ui) { onDone('unreachable'); return; }
    if (stepIndex > 0 && isPromptBlockingInput(ui)) { onDone('stopped-by-prompt'); return; }
    if (!sendTerminalInput(ui, step.data)) { onDone('unreachable'); return; }
    sendKeystrokePlan(sessionId, ui, steps, onDone, stepIndex + 1);
  }, step.delayBeforeMs);
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
  const traceUnavailableNote = el('p', 'conversation-bridge-note', 'The session trace is unavailable, so there is nothing to show here. Use the terminal.');
  traceUnavailableNote.hidden = true;
  const composer = el('form', 'conversation-composer');
  const status = el('p', 'conversation-status');
  status.setAttribute('role', 'status');
  const composerRow = el('div', 'conversation-composer-row');
  const attachButton = composerIconButton('conversation-attach', ATTACH_GLYPH, 'Attach a photo or file');
  const filePicker = el('input', 'conversation-file-picker');
  filePicker.type = 'file';
  filePicker.hidden = true;
  const input = el('textarea', 'conversation-input');
  input.rows = 1;
  input.placeholder = 'Message the agent';
  input.setAttribute('aria-label', 'Message the agent');
  const stopButton = composerIconButton('conversation-stop', STOP_GLYPH, 'Stop the current turn (Esc)');
  const sendButton = composerIconButton('conversation-send', SEND_GLYPH, 'Send');
  sendButton.type = 'submit';
  composerRow.append(attachButton, input, stopButton, sendButton);
  composer.append(status, composerRow, filePicker);
  root.append(log, traceUnavailableNote, bridgeNote, approvalSlot, composer);

  let sessionId: string | null = null;
  let records: TraceRecord[] = [];
  let nextOffset = 0;
  let hasLoadedOnce = false;
  let pendingRequest: PendingTraceRequest | null = null;
  let isRefreshOwed = false;
  let hasPendingAttachment = false;
  let isAttachmentUploading = false;

  function currentUi(): SessionUi | null {
    return sessionId ? findSessionUi(sessionId) ?? null : null;
  }

  function setStatus(text: string) {
    status.textContent = text;
  }

  function fitInputToText() {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`;
  }

  function clearPendingRequest() {
    if (pendingRequest) clearTimeout(pendingRequest.timeoutHandle);
    pendingRequest = null;
  }

  function requestRecords() {
    if (!sessionId || root.hidden || !traceUnavailableNote.hidden) return;
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

  function renderImage(imageUrl: string) {
    const link = el('a', 'conversation-image-link');
    link.href = imageUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    const image = el('img', 'conversation-image');
    image.src = imageUrl;
    image.alt = 'Attached image';
    image.loading = 'lazy';
    image.addEventListener('error', () => link.remove(), { once: true });
    link.append(image);
    return link;
  }

  function renderMessage(entry: Extract<ConversationEntry, { kind: 'user' | 'assistant' | 'notice' }>) {
    const bubble = el('article', `conversation-message conversation-${entry.kind}`);
    if (entry.kind === 'assistant') {
      bubble.append(renderPlanBlocks(parsePlanMarkdown(entry.text)));
      return bubble;
    }
    bubble.append(el('p', 'conversation-text', entry.text));
    if (entry.kind === 'user') bubble.append(...entry.imageUrls.map(renderImage));
    return bubble;
  }

  function renderWorkGroup(group: ConversationWorkGroup) {
    const line = el('p', 'conversation-work', workGroupHeadline(group));
    if (isWorkGroupRunning(group)) line.classList.add('is-running');
    if (group.errorCount > 0) line.classList.add('has-error');
    return line;
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
    const statusByOutcome: Record<KeystrokePlanOutcome, string> = {
      sent: sentText,
      unreachable: 'Unable to reach this session.',
      'stopped-by-prompt': 'Not sent: a prompt appeared, so the message was typed but not submitted. Check the terminal.',
    };
    sendKeystrokePlan(sessionId, ui, steps, (outcome) => setStatus(statusByOutcome[outcome]));
  }

  function answerApproval(approval: ConversationApproval, decision: ConversationApprovalDecision, answers?: ConversationAnswers) {
    if (!sessionId) return;
    const isSent = sendControl({ type: 'conversation-approval', id: sessionId, requestId: approval.requestId, decision, ...(answers ? { answers } : {}) });
    setStatus(isSent ? 'Answer sent.' : 'Unable to send the answer while disconnected.');
  }

  function approvalButton(label: string, onClick: () => void) {
    const button = el('button', 'conversation-approval-action', label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }

  function approvalTitle(approval: ConversationApproval): string {
    if (approval.kind === 'tool') return `Allow ${approval.toolName ?? 'this tool'}?`;
    return CODEX_APPROVAL_TITLES[approval.kind] ?? 'Approve this request?';
  }

  function renderUnshownApproval(approval: ConversationApproval) {
    approvalSlot.append(el('p', 'conversation-approval-note', 'This request cannot be shown in full here. Read and answer it in the terminal.'));
    const actions = el('div', 'conversation-approval-actions');
    actions.append(approvalButton('Open terminal', () => showTerminal()), approvalButton('Decline', () => answerApproval(approval, 'decline')));
    approvalSlot.append(actions);
  }

  function renderToolApproval(approval: ConversationApproval) {
    approvalSlot.append(el('p', 'conversation-approval-title', approvalTitle(approval)), el('pre', 'conversation-approval-summary', approval.summary));
    if (approval.isSummaryTruncated) { renderUnshownApproval(approval); return; }
    const actions = el('div', 'conversation-approval-actions');
    actions.append(approvalButton('Approve', () => answerApproval(approval, 'accept')));
    if (approval.kind !== 'tool') actions.append(approvalButton('Approve for session', () => answerApproval(approval, 'acceptForSession')));
    if (approval.alwaysAllowSummary) {
      approvalSlot.append(el('p', 'conversation-approval-note', `Always allow adds, for this session only: ${approval.alwaysAllowSummary}`));
      actions.append(approvalButton('Always allow', () => answerApproval(approval, 'acceptForSession')));
    }
    actions.append(approvalButton('Decline', () => answerApproval(approval, 'decline')));
    approvalSlot.append(actions);
  }

  function renderQuestionText(question: ConversationQuestion) {
    const heading = el('p', 'conversation-approval-title', question.question);
    if (question.header) heading.prepend(el('span', 'conversation-question-header', question.header));
    return heading;
  }

  function renderSingleQuestion(approval: ConversationApproval, question: ConversationQuestion) {
    approvalSlot.append(renderQuestionText(question));
    const options = el('div', 'conversation-question-options');
    for (const option of question.options) {
      const button = approvalButton(option.label, () => answerApproval(approval, 'accept', { [question.question]: option.label }));
      if (option.description) button.title = option.description;
      options.append(button);
    }
    const actions = el('div', 'conversation-approval-actions');
    actions.append(approvalButton('Decline', () => answerApproval(approval, 'decline')));
    approvalSlot.append(options, actions);
  }

  function renderQuestionForm(approval: ConversationApproval, questions: readonly ConversationQuestion[]) {
    const form = el('form', 'conversation-question-form');
    questions.forEach((question, questionIndex) => {
      const fieldset = el('fieldset', 'conversation-question');
      const legend = el('legend', 'conversation-question-text', question.question);
      if (question.header) legend.prepend(el('span', 'conversation-question-header', question.header));
      fieldset.append(legend);
      for (const option of question.options) {
        const label = el('label', 'conversation-question-option');
        const choice = el('input');
        choice.type = question.multiSelect ? 'checkbox' : 'radio';
        choice.name = `question-${questionIndex}`;
        choice.value = option.label;
        label.append(choice, el('span', '', option.label));
        if (option.description) label.title = option.description;
        fieldset.append(label);
      }
      form.append(fieldset);
    });
    const actions = el('div', 'conversation-approval-actions');
    const submitButton = el('button', 'conversation-approval-action', 'Send answers');
    submitButton.type = 'submit';
    actions.append(submitButton, approvalButton('Decline', () => answerApproval(approval, 'decline')));
    form.append(actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const answers: ConversationAnswers = {};
      questions.forEach((question, questionIndex) => {
        const chosen = [...form.querySelectorAll<HTMLInputElement>(`input[name="question-${questionIndex}"]:checked`)].map((choice) => choice.value);
        if (chosen.length > 0) answers[question.question] = chosen.join(MULTI_SELECT_ANSWER_SEPARATOR);
      });
      if (Object.keys(answers).length !== questions.length) { setStatus('Answer every question first.'); return; }
      answerApproval(approval, 'accept', answers);
    });
    approvalSlot.append(form);
  }

  function renderQuestionApproval(approval: ConversationApproval) {
    const questions = approval.questions ?? [];
    if (approval.isSummaryTruncated || questions.length === 0) {
      approvalSlot.append(el('p', 'conversation-approval-title', 'Claude Code has a question'), el('pre', 'conversation-approval-summary', approval.summary));
      renderUnshownApproval(approval);
      return;
    }
    const [firstQuestion] = questions;
    if (questions.length === 1 && !firstQuestion.multiSelect) { renderSingleQuestion(approval, firstQuestion); return; }
    renderQuestionForm(approval, questions);
  }

  function renderPendingApproval(approval: ConversationApproval) {
    if (approval.kind === 'question') { renderQuestionApproval(approval); return; }
    renderToolApproval(approval);
  }

  function renderTerminalOnlyPrompt() {
    approvalSlot.append(el('p', 'conversation-approval-title', 'The agent is waiting on a prompt'));
    approvalSlot.append(el('p', 'conversation-approval-note', 'Read and answer it in the terminal.'));
    const actions = el('div', 'conversation-approval-actions');
    actions.append(approvalButton('Open terminal', () => showTerminal()));
    approvalSlot.append(actions);
  }

  function renderApproval() {
    const ui = currentUi();
    approvalSlot.replaceChildren();
    const pendingApproval = ui?.conversationApproval ?? null;
    const isPromptShowing = ui ? isAnyPromptShowing(ui.currentState, ui.pendingPromptKind) : false;
    const isAwaitingBridge = ui?.agent === 'codex' && !ui.hasConversationBridge;
    bridgeNote.hidden = !isAwaitingBridge;
    approvalSlot.hidden = !pendingApproval && !isPromptShowing;
    sendButton.disabled = !approvalSlot.hidden || isAwaitingBridge;
    renderAttachAvailability();
    if (!ui) return;
    if (pendingApproval) { renderPendingApproval(pendingApproval); return; }
    if (!isPromptShowing) return;
    renderTerminalOnlyPrompt();
  }

  function renderAttachAvailability() {
    attachButton.disabled = sendButton.disabled || isAttachmentUploading;
  }

  function composerSubmitSteps(agent: string | null | undefined): readonly TimedKeystroke[] | null {
    const typedSteps = composerKeystrokes(agent, input.value);
    if (typedSteps || !hasPendingAttachment) return typedSteps;
    return submitKeystrokes(agent);
  }

  function renderControls() {
    const ui = currentUi();
    stopButton.disabled = ui?.currentState !== STATES.RUNNING;
  }

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    if (sendButton.disabled) return;
    const steps = composerSubmitSteps(currentUi()?.agent);
    if (!steps) return;
    input.value = '';
    fitInputToText();
    hasPendingAttachment = false;
    sendPlan(steps, 'Sent.');
  }, { signal });
  input.addEventListener('input', fitInputToText, { signal });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || isPhoneLayout()) return;
    event.preventDefault();
    composer.requestSubmit();
  }, { signal });
  stopButton.addEventListener('click', () => sendPlan(interruptKeystrokes(currentUi()?.agent), 'Interrupt sent.'), { signal });
  attachButton.addEventListener('click', () => filePicker.click(), { signal });
  filePicker.addEventListener('change', () => {
    const pickedFile = filePicker.files?.[0];
    filePicker.value = '';
    if (!pickedFile || !sessionId) return;
    if (sendButton.disabled) { setStatus('Not attached: the agent is not ready for a message. Check the terminal.'); return; }
    const uploadSessionId = sessionId;
    isAttachmentUploading = true;
    renderAttachAvailability();
    void uploadFileToSession(uploadSessionId, pickedFile).then((isUploaded) => {
      isAttachmentUploading = false;
      renderAttachAvailability();
      if (!isUploaded || sessionId !== uploadSessionId) return;
      hasPendingAttachment = true;
      setStatus('Attached. It goes with your next message.');
    });
  }, { signal });

  function show(id: string) {
    if (sessionId !== id) {
      sessionId = id;
      records = [];
      nextOffset = 0;
      hasLoadedOnce = false;
      clearPendingRequest();
      hasPendingAttachment = false;
      setStatus('');
    }
    root.hidden = false;
    traceUnavailableNote.hidden = true;
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

  function applyTraceError(error: ServerMessageOf<'error'>): boolean {
    if (!pendingRequest || error.requestId !== pendingRequest.requestId) return false;
    clearPendingRequest();
    isRefreshOwed = false;
    traceUnavailableNote.hidden = false;
    return true;
  }

  function applyTraceChanged(id: string) {
    if (id !== sessionId || root.hidden) return;
    traceUnavailableNote.hidden = true;
    requestRecords();
  }

  return { el: root, show, hide, refresh, applyTraceResponse, applyTraceError, applyTraceChanged };
}
