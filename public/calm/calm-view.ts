import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { PendingPromptDetail } from '#shared/contracts/session.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { createUnseenCompleteTracker } from '../focus-view/unseen-complete-core.ts';
import { isPhoneLayout } from '../form-factor.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { sessionName, sessionUIs } from '../session-card/card-registry.ts';
import { trapFocus } from '../session-card/modal.ts';
import { restartMessage } from '../session-card/restart-menu-core.ts';
import { onSessionTick } from '../session-card/session-tick.ts';
import { ensureTerminalReady, onTerminalInput, sendTerminalInput } from '../session-card/terminal.ts';
import { parseUnifiedDiff, summarizeFiles } from '../sidebar/diff-core.ts';
import { traceRowParts } from '../trace-view-core.ts';
import { uiState } from '../ui-state-core.ts';
import { LATER_RADIUS, NEXT_RADIUS, NOW_RADIUS, placeLights, shouldShowLabels } from './calm-field-core.ts';
import { latestPendingReview } from './calm-plan-core.ts';
import type { ArmedAdvance, CalmRow } from './calm-priority-core.ts';
import { canReplyToFinishedSession, countByTier, decideArmedAdvance, formatWaitTime, isSamePermissionPrompt, offersReplyInput, orderCalmQueue, panelContextFor, pickComponent, pickNextQueueSessionId, pickNowPeek, pickSessionAfterSubmit, tierOf } from './calm-priority-core.ts';
import type { TimedKeystroke } from './permission-keys-core.ts';
import { answerWithOptionKeystrokes, answerWithTextKeystrokes, approveKeystrokes, decideInstructionDelivery, INSTRUCTION_POLL_INTERVAL_MS, isAnyPromptShowing, rejectAndInstructKeystrokes, replyKeystrokes } from './permission-keys-core.ts';

const unseenTracker = createUnseenCompleteTracker();
const glyphByTier = { now: '\u25b2', next: '\u25a0', later: '\u2713', working: '\u00b7', resting: '\u00b7' };
interface CalmNavigation { openTerminal: (id: string) => void; openPlan: (id: string) => void; onSheetOpenChange?: (isOpen: boolean) => void }
interface CalmSurface { kind: 'desktop' | 'phone'; root: HTMLElement; navigation: CalmNavigation }
let desktopSurface: CalmSurface | null = null;
let openDesktopCalm: () => void = () => {};
let surface: CalmSurface | null = null;
let field: HTMLDivElement | null = null;
let panel: HTMLElement | null = null;
let sheetScrim: HTMLDivElement | null = null;
let isSheetOpenReported = false;
let selectedSessionId: string | null = null;
let selectedComponent: string | null = null;
let selectedFingerprint = '';
let primaryButton: HTMLButtonElement | null = null;
let openedFromQueueSessionId: string | null = null;
let armedAdvance: (ArmedAdvance & { hasOtherInputArrived: boolean }) | null = null;
let queueCursorSessionId: string | null = null;
let nowPeek: { card: HTMLElement; name: HTMLElement; context: HTMLElement; wait: HTMLElement } | null = null;
let nowPeekSessionId: string | null = null;
let nowPeekStateSince: number | null = null;
let opener: HTMLElement | null = null;
let pendingCalmRequest: { id: string; kind: 'trace' | 'diff' | 'plan' } | null = null;
const calmStatusBySessionId = new Map<string, { text: string; recordedAtMs: number; promptSummary: string | undefined }>();

const CALM_STATUS_LIFETIME_MS = 15000;
const PROMPT_STILL_OPEN_STATUS = 'The prompt is still open. Open Terminal to continue.';
const UNABLE_TO_SEND_STATUS = 'Unable to send. Open Terminal to continue.';
const QUESTION_CHANGED_STATUS = 'The question changed. Open Terminal to continue.';
const SESSION_BUSY_STATUS = 'The session is busy. Open Terminal to continue.';
const PHONE_RING_SCALE = 50;
const FOOTER_TEXT_BY_SURFACE = {
  desktop: 'Click a light for its action. Faint field lights are working sessions.',
  phone: 'Tap a light or a row for its action. Faint field lights are working sessions.',
};

function isDesktopSurfaceActive() {
  return surface !== null && surface === desktopSurface && !isPhoneLayout();
}

function readRows(): CalmRow[] {
  const rows = [...sessionUIs].map(([id, ui]) => ({
    id, name: sessionName(ui), state: ui.currentState, stateSince: ui.stateSince,
    agent: ui.agent, pendingPromptKind: ui.pendingPromptKind, pendingPromptDetail: ui.pendingPromptDetail,
  }));
  unseenTracker.noteStates(rows);
  return rows.map((row) => ({ ...row, unseen: unseenTracker.isUnseen(row.id) }));
}

function findLight(sessionId: string | undefined) {
  if (!field) return null;
  return [...field.querySelectorAll<HTMLButtonElement>('.calm-light')].find((button) => button.dataset.sessionId === sessionId) ?? null;
}

function detachPanel() {
  panel?.parentElement?.classList.remove('calm-has-panel');
  panel?.remove();
  sheetScrim?.remove();
  sheetScrim = null;
  panel = null;
  selectedSessionId = null;
  selectedComponent = null;
  selectedFingerprint = '';
  primaryButton = null;
  pendingCalmRequest = null;
  if (field) field.inert = false;
  if (opener?.isConnected) { opener.focus(); return; }
  findLight(opener?.dataset.sessionId)?.focus();
}

function reportSheetOpenChange() {
  const isSheetOpen = panel !== null && surface?.kind === 'phone';
  if (isSheetOpen === isSheetOpenReported) return;
  isSheetOpenReported = isSheetOpen;
  surface?.navigation.onSheetOpenChange?.(isSheetOpen);
}

function closePanel() {
  detachPanel();
  reportSheetOpenChange();
}

function dismissPanel() {
  if (selectedSessionId) calmStatusBySessionId.delete(selectedSessionId);
  closePanel();
}

function reportCalmStatus(sessionId: string, text: string, promptSummary: string | undefined) {
  calmStatusBySessionId.set(sessionId, { text, recordedAtMs: Date.now(), promptSummary });
  if (!panel || selectedSessionId !== sessionId) return;
  const liveStatus = panel.querySelector('.calm-status');
  if (liveStatus) liveStatus.textContent = text;
}

function promptStatusKeyOf(detail: PendingPromptDetail | null | undefined) {
  return detail?.question?.text ?? detail?.summary;
}

function readFreshCalmStatus(sessionId: string, pendingPromptSummary: string | undefined) {
  const recorded = calmStatusBySessionId.get(sessionId);
  if (!recorded) return '';
  const isExpired = Date.now() - recorded.recordedAtMs >= CALM_STATUS_LIFETIME_MS;
  const isNewPrompt = pendingPromptSummary !== undefined && pendingPromptSummary !== recorded.promptSummary;
  if (!isExpired && !isNewPrompt) return recorded.text;
  calmStatusBySessionId.delete(sessionId);
  return '';
}

function forgetRemovedSessionStatuses() {
  for (const sessionId of calmStatusBySessionId.keys()) {
    if (!sessionUIs.has(sessionId)) calmStatusBySessionId.delete(sessionId);
  }
}

function createButton(label: string, className: string, action: () => void) {
  const button = el('button', className, label);
  button.type = 'button';
  button.addEventListener('click', action);
  return button;
}

function claimPendingCalmRequest(id: string | undefined, kinds: readonly string[]) {
  if (!pendingCalmRequest || pendingCalmRequest.id !== id || !kinds.includes(pendingCalmRequest.kind)) return false;
  pendingCalmRequest = null;
  return true;
}

function renderTrace(id: string, body: HTMLElement) {
  body.classList.add('calm-trace');
  body.textContent = 'Loading trace...';
  if (!sendControlMsg({ type: 'session-trace', id, endingAt: 'tail' })) { body.textContent = 'Trace unavailable. Open Terminal to continue.'; return; }
  pendingCalmRequest = { id, kind: 'trace' };
}

export function applyCalmTraceResponse(reply: ServerMessageOf<'session-trace-response'>) {
  if (!claimPendingCalmRequest(reply.id, ['trace'])) return;
  if (!surface || selectedSessionId !== reply.id || !panel) return;
  if (selectedComponent !== 'failure' && selectedComponent !== 'terminal') return;
  const body = panel.querySelector('.calm-trace');
  if (!body) return;
  const toolCalls = reply.records.filter((record) => record.kind === 'tool_call');
  const toolCallByUseId = new Map(toolCalls.map((record) => [record.toolUseId, record]));
  const records = selectedComponent === 'failure' ? toolCalls : reply.records;
  body.replaceChildren(...records.slice(-3).map((record) => el('div', 'calm-trace-row', traceRowParts(record, toolCallByUseId).text)));
  if (!records.length) body.textContent = 'No trace has been recorded.';
}

export function applyCalmError(reply: ServerMessageOf<'error'>) {
  const isPlanDecisionError = reply.scope === 'plan-decision';
  if (!claimPendingCalmRequest(reply.id, isPlanDecisionError ? ['plan'] : ['trace', 'diff'])) return;
  if (!surface || selectedSessionId !== reply.id || !panel) return;
  const target = panel.querySelector(isPlanDecisionError ? '.calm-status' : '.calm-trace, .calm-diff');
  if (target) target.textContent = reply.message;
}

interface KeystrokeDelivery {
  sentStatus: string;
  failedStatus: string;
  blockedStatusBefore: (ui: SessionUi, stepIndex: number) => string | null;
}

const INSTRUCTION_DELIVERY: KeystrokeDelivery = {
  sentStatus: 'Instruction sent.',
  failedStatus: 'Unable to send instruction.',
  blockedStatusBefore: (ui) => (isAnyPromptShowing(ui.currentState, ui.pendingPromptKind) ? PROMPT_STILL_OPEN_STATUS : null),
};

function sendTimedKeystrokes(sessionId: string, ui: SessionUi, steps: readonly TimedKeystroke[], delivery: KeystrokeDelivery, reportStatus: (text: string) => void, stepIndex = 0) {
  const step = steps[stepIndex];
  if (!step) { reportStatus(delivery.sentStatus); return; }
  setTimeout(() => {
    if (sessionUIs.get(sessionId) !== ui) { reportStatus(delivery.failedStatus); return; }
    const blockedStatus = delivery.blockedStatusBefore(ui, stepIndex);
    if (blockedStatus) { reportStatus(blockedStatus); return; }
    if (!sendTerminalInput(ui, step.data)) { reportStatus(delivery.failedStatus); return; }
    sendTimedKeystrokes(sessionId, ui, steps, delivery, reportStatus, stepIndex + 1);
  }, step.delayBeforeMs);
}

function sendInstructionOncePromptCloses(sessionId: string, ui: SessionUi, steps: readonly TimedKeystroke[], waitStartedAt: number, reportStatus: (text: string) => void) {
  if (sessionUIs.get(sessionId) !== ui) { reportStatus('Unable to send instruction.'); return; }
  const delivery = decideInstructionDelivery({ currentState: ui.currentState, pendingPromptKind: ui.pendingPromptKind, elapsedMs: Date.now() - waitStartedAt });
  if (delivery === 'give-up') { reportStatus(PROMPT_STILL_OPEN_STATUS); return; }
  if (delivery === 'send') { sendTimedKeystrokes(sessionId, ui, steps, INSTRUCTION_DELIVERY, reportStatus); return; }
  setTimeout(() => sendInstructionOncePromptCloses(sessionId, ui, steps, waitStartedAt, reportStatus), INSTRUCTION_POLL_INTERVAL_MS);
}

function buildAnswerInput(placeholder: string, label: string, onSubmit: (input: HTMLInputElement) => void) {
  const input = el('input', 'calm-input');
  input.type = 'text';
  input.placeholder = placeholder;
  input.setAttribute('aria-label', label);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || !input.value.trim()) return;
    event.preventDefault();
    onSubmit(input);
  });
  return input;
}

function appendQuestionAnswer(row: CalmRow, ui: SessionUi, body: HTMLElement, actions: HTMLElement) {
  const question = row.pendingPromptDetail?.question;
  if (!question) return;
  const reportAnswerStatus = (text: string) => reportCalmStatus(row.id, text, promptStatusKeyOf(row.pendingPromptDetail));
  const isSameQuestionStillShowing = () => isSamePermissionPrompt(ui.currentState, ui.pendingPromptKind, ui.pendingPromptDetail, row.pendingPromptDetail);
  const answerControls: (HTMLButtonElement | HTMLInputElement)[] = [];
  const disableAnswerControls = () => { for (const control of answerControls) control.disabled = true; };
  const optionList = el('div', 'calm-options');
  question.options.forEach((label, optionIndex) => {
    const button = createButton(label, 'calm-option', () => {
      if (button.disabled) return;
      const keystrokes = answerWithOptionKeystrokes(row.agent, optionIndex, question.options.length, question.multiSelect);
      if (!keystrokes) { reportAnswerStatus(UNABLE_TO_SEND_STATUS); return; }
      if (!isSameQuestionStillShowing()) { reportAnswerStatus(QUESTION_CHANGED_STATUS); return; }
      ensureTerminalReady(ui, row.id);
      if (!keystrokes.every((keystroke) => sendTerminalInput(ui, keystroke.data))) { reportAnswerStatus(UNABLE_TO_SEND_STATUS); return; }
      disableAnswerControls();
      reportAnswerStatus('Answer sent.');
    });
    answerControls.push(button);
    optionList.append(button);
  });
  const input = buildAnswerInput('or type your own answer', 'Or type your own answer', (answerInput) => {
    const steps = answerWithTextKeystrokes(row.agent, question.options.length, answerInput.value, question.multiSelect);
    if (!steps) { reportAnswerStatus(UNABLE_TO_SEND_STATUS); return; }
    if (!isSameQuestionStillShowing()) { reportAnswerStatus(QUESTION_CHANGED_STATUS); return; }
    ensureTerminalReady(ui, row.id);
    disableAnswerControls();
    reportAnswerStatus('Sending answer...');
    sendTimedKeystrokes(row.id, ui, steps, {
      sentStatus: 'Answer sent.',
      failedStatus: UNABLE_TO_SEND_STATUS,
      blockedStatusBefore: (_currentUi, stepIndex) => (stepIndex === 0 && !isSameQuestionStillShowing() ? QUESTION_CHANGED_STATUS : null),
    }, reportAnswerStatus);
  });
  answerControls.push(input);
  body.append(el('h2', 'calm-question', question.text), optionList);
  actions.append(input);
}

function appendReplyInput(row: CalmRow, ui: SessionUi, actions: HTMLElement) {
  const reportReplyStatus = (text: string) => reportCalmStatus(row.id, text, promptStatusKeyOf(row.pendingPromptDetail));
  const isReadyForReply = (currentUi: SessionUi) => canReplyToFinishedSession(currentUi.currentState, currentUi.pendingPromptKind);
  const input = buildAnswerInput('next instruction', 'Next instruction', (replyInput) => {
    const steps = replyKeystrokes(row.agent, replyInput.value);
    if (!steps) { reportReplyStatus(UNABLE_TO_SEND_STATUS); return; }
    if (!isReadyForReply(ui)) { reportReplyStatus(SESSION_BUSY_STATUS); return; }
    ensureTerminalReady(ui, row.id);
    replyInput.disabled = true;
    sendTimedKeystrokes(row.id, ui, steps, {
      sentStatus: 'Instruction sent.',
      failedStatus: UNABLE_TO_SEND_STATUS,
      blockedStatusBefore: (currentUi, stepIndex) => (stepIndex === 0 && !isReadyForReply(currentUi) ? SESSION_BUSY_STATUS : null),
    }, reportReplyStatus);
    unseenTracker.acknowledge(row.id);
    reportReplyStatus('Sending instruction...');
  });
  actions.append(input);
}

function openPanel(row: CalmRow) {
  const ui = sessionUIs.get(row.id);
  const activeSurface = surface;
  if (!activeSurface || !ui) return;
  const { root, navigation } = activeSurface;
  detachPanel();
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  selectedSessionId = row.id;
  const choice = pickComponent(row);
  selectedComponent = choice.component;
  selectedFingerprint = JSON.stringify([row, ui.planReviewState]);
  panel = el('article', 'calm-panel');
  panel.dataset.tier = tierOf(row);
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', `${row.name}, ${choice.component}`);
  trapFocus(panel);
  const header = el('header', 'calm-panel-header');
  const panelTitle = el('span', 'calm-panel-title', `${glyphByTier[tierOf(row)]} ${row.name} ${panelContextFor(row, choice.component)}`);
  panelTitle.tabIndex = -1;
  header.append(panelTitle, createButton('Terminal', 'calm-link', () => openTerminalFromQueue(row.id)));
  if (activeSurface.kind === 'phone') header.append(createButton('Close', 'calm-link', dismissPanel));
  const body = el('div', 'calm-panel-body');
  const actions = el('div', 'calm-actions');
  const status = el('span', 'calm-status', readFreshCalmStatus(row.id, promptStatusKeyOf(row.pendingPromptDetail)));
  status.setAttribute('role', 'status');
  const addPrimary = (label: string, action: () => boolean) => {
    const button = createButton(label, 'calm-primary', () => {
      if (button.disabled) return;
      if (action() === false) { status.textContent = UNABLE_TO_SEND_STATUS; return; }
      button.disabled = true;
      status.textContent = 'Action sent.';
    });
    primaryButton = button;
    actions.append(button);
  };
  if (choice.component === 'permission') {
    body.append(el('div', 'calm-tool-name', row.pendingPromptDetail?.toolName ?? ''), el('pre', 'calm-summary', row.pendingPromptDetail?.summary ?? ''));
    if (!choice.canApprove) body.append(el('p', 'calm-caption', 'Review the full request in the terminal.'));
    const isSamePromptStillShowing = () => isSamePermissionPrompt(ui.currentState, ui.pendingPromptKind, ui.pendingPromptDetail, row.pendingPromptDetail);
    const approveKeys = approveKeystrokes(row.agent);
    const reportInstructionStatus = (text: string) => reportCalmStatus(row.id, text, promptStatusKeyOf(row.pendingPromptDetail));
    if (choice.canApprove && approveKeys) {
      addPrimary('Approve', () => {
        if (!isSamePromptStillShowing()) return false;
        ensureTerminalReady(ui, row.id);
        return approveKeys.every((keystroke) => sendTerminalInput(ui, keystroke.data));
      });
      const input = buildAnswerInput('or tell it what to do instead', 'Or tell it what to do instead', (redirectInput) => {
        const redirectPlan = rejectAndInstructKeystrokes(row.agent, redirectInput.value);
        if (!redirectPlan) { reportInstructionStatus(UNABLE_TO_SEND_STATUS); return; }
        if (!isSamePromptStillShowing()) { reportInstructionStatus('The prompt changed. Open Terminal to continue.'); return; }
        ensureTerminalReady(ui, row.id);
        if (!redirectPlan.dismissPrompt.every((keystroke) => sendTerminalInput(ui, keystroke.data))) { reportInstructionStatus(UNABLE_TO_SEND_STATUS); return; }
        redirectInput.disabled = true;
        if (primaryButton) primaryButton.disabled = true;
        reportInstructionStatus('Sending instruction...');
        sendInstructionOncePromptCloses(row.id, ui, redirectPlan.instruct, Date.now(), reportInstructionStatus);
      });
      actions.append(input);
    }
  }
  if (choice.component === 'question') appendQuestionAnswer(row, ui, body, actions);
  if (choice.component === 'plan') {
    const review = latestPendingReview(ui.planReviewState);
    const revision = review?.openRevision?.revision;
    const title = review?.revisions.find((entry) => entry.revision === revision)?.title;
    body.append(el('p', 'calm-summary', title || 'Plan ready for review'));
    if (review && revision) addPrimary('Approve plan', () => {
      const latestReview = latestPendingReview(ui.planReviewState);
      if (!latestReview?.openRevision) { navigation.openPlan(row.id); return true; }
      if (!sendControlMsg({ type: 'plan-decision', id: row.id, agentId: latestReview.agentId, revision: latestReview.openRevision.revision, decision: 'approve' })) return false;
      pendingCalmRequest = { id: row.id, kind: 'plan' };
      return true;
    });
    if (!review || !revision) addPrimary('Open plan', () => { navigation.openPlan(row.id); return true; });
    actions.append(createButton('Open plan', 'calm-link', () => navigation.openPlan(row.id)));
  }
  if (choice.component === 'failure') {
    body.append(el('p', 'calm-summary', 'Exited with a failure'));
    const trace = el('div', 'calm-trace');
    body.append(trace);
    renderTrace(row.id, trace);
    addPrimary('Resume', () => sendControlMsg(restartMessage('restart', ui.currentState, row.id)));
  }
  if (choice.component === 'terminal') renderTrace(row.id, body);
  if (choice.component === 'review') {
    body.classList.add('calm-diff');
    body.textContent = 'Loading files...';
    const isDiffRequested = sendControlMsg({ type: 'request-session-diff', id: row.id });
    if (isDiffRequested) pendingCalmRequest = { id: row.id, kind: 'diff' };
    if (!isDiffRequested) body.textContent = 'Diff unavailable. Open review to continue.';
    addPrimary('Open review', () => { unseenTracker.acknowledge(row.id); navigation.openTerminal(row.id); return true; });
    if (offersReplyInput(row)) appendReplyInput(row, ui, actions);
  }
  actions.append(status);
  panel.append(header, body, actions);
  root.classList.add('calm-has-panel');
  if (activeSurface.kind === 'phone') root.append(buildSheetScrim());
  root.append(panel);
  if (field) field.inert = true;
  panelTitle.focus();
  reportSheetOpenChange();
}

export function applyCalmSessionDiff(reply: ServerMessageOf<'session-diff'>) {
  if (!claimPendingCalmRequest(reply.id, ['diff'])) return;
  if (!surface || selectedComponent !== 'review' || selectedSessionId !== reply.id || !panel) return;
  const body = panel.querySelector('.calm-diff');
  if (!body) return;
  const files = parseUnifiedDiff(`${reply.committed.diff}\n${reply.uncommitted.diff}`);
  const summary = summarizeFiles(files);
  body.replaceChildren(el('p', 'calm-summary', `${summary.files} files / +${summary.added} -${summary.removed}`),
    ...files.map((file) => el('div', 'calm-file', `${file.path}  +${file.added} -${file.removed}`)));
}

function buildSheetScrim() {
  sheetScrim = el('div', 'calm-sheet-scrim');
  sheetScrim.setAttribute('aria-hidden', 'true');
  sheetScrim.addEventListener('click', dismissPanel);
  return sheetScrim;
}

function buildTierHeader(rows: readonly CalmRow[]) {
  const counts = countByTier(rows);
  const header = el('header', 'calm-header');
  for (const tier of ['now', 'next', 'later', 'working'] as const) {
    const count = el('span', 'calm-count', `${glyphByTier[tier]} ${counts[tier]} ${tier}`);
    count.dataset.tier = tier;
    header.append(count);
  }
  return header;
}

function ringScaleFor(activeSurface: CalmSurface) {
  if (activeSurface.kind === 'phone') return PHONE_RING_SCALE;
  return activeSurface.root.clientWidth <= 640 ? 34 : 50;
}

function buildRings(rows: readonly CalmRow[], activeSurface: CalmSurface) {
  const ringScale = ringScaleFor(activeSurface);
  const rings = el('div', 'calm-rings');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tier, radius] of [['now', NOW_RADIUS], ['next', NEXT_RADIUS], ['later', LATER_RADIUS]] as const) {
    const circle = document.createElementNS(svg.namespaceURI, 'circle');
    for (const [name, value] of Object.entries({ cx: '50', cy: '50', r: String(radius * ringScale), 'data-tier': tier })) circle.setAttribute(name, value);
    svg.append(circle);
    const label = el('span', 'calm-ring-label', tier.toUpperCase());
    label.style.top = `${50 - radius * ringScale + 2}%`;
    rings.append(label);
  }
  rings.prepend(svg);
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const showLabels = activeSurface.kind === 'desktop' && shouldShowLabels(activeSurface.root.clientWidth);
  for (const light of placeLights(rows.map((row) => ({ id: row.id, tier: tierOf(row) })), 0.24)) {
    const row = rowsById.get(light.id);
    if (!row) continue;
    const button = createButton('', 'calm-light', () => openPanel(row));
    button.dataset.tier = light.tier;
    button.dataset.sessionId = row.id;
    button.setAttribute('aria-label', `${row.name}, ${light.tier}`);
    button.style.left = `${50 + Math.cos(light.angle) * light.radius * ringScale}%`;
    button.style.top = `${50 + Math.sin(light.angle) * light.radius * ringScale}%`;
    button.append(el('span', 'calm-light-dot'));
    if (showLabels && light.tier !== 'working') {
      const label = el('span', 'calm-light-label', row.name);
      label.append(el('span', 'calm-light-context', row.pendingPromptKind || row.state.toLowerCase()));
      button.append(label);
    }
    rings.append(button);
  }
  return rings;
}

function buildDesktopNowList(rows: readonly CalmRow[]) {
  const nowList = el('div', 'calm-now-list');
  nowList.setAttribute('aria-label', 'NOW sessions');
  for (const row of orderCalmQueue(rows).filter((entry) => tierOf(entry) === 'now')) nowList.append(createButton(`${glyphByTier.now} ${row.name}`, 'calm-now-row', () => openPanel(row)));
  return nowList;
}

function waitTextSince(stateSince: number) {
  return formatWaitTime(Date.now() - stateSince);
}

function buildPhoneNowList(rows: readonly CalmRow[]) {
  const nowList = el('div', 'calm-now-list');
  nowList.setAttribute('aria-label', 'NOW sessions');
  for (const row of orderCalmQueue(rows).filter((entry) => tierOf(entry) === 'now')) {
    const context = panelContextFor(row, pickComponent(row).component);
    const button = createButton('', 'calm-now-row', () => openPanel(row));
    button.setAttribute('aria-label', `${row.name}, ${context}`);
    const glyph = el('span', 'calm-now-glyph', glyphByTier.now);
    glyph.setAttribute('aria-hidden', 'true');
    const details = el('span', 'calm-now-details');
    details.append(el('span', 'calm-now-name', row.name), el('span', 'calm-now-context', context));
    const wait = el('span', 'calm-now-wait');
    wait.setAttribute('aria-hidden', 'true');
    if (typeof row.stateSince === 'number') {
      wait.dataset.stateSince = String(row.stateSince);
      wait.textContent = waitTextSince(row.stateSince);
    }
    button.append(glyph, details, wait);
    nowList.append(button);
  }
  return nowList;
}

function refreshNowRowWaits() {
  if (!field || surface?.kind !== 'phone') return;
  for (const wait of field.querySelectorAll<HTMLElement>('.calm-now-wait[data-state-since]')) {
    wait.textContent = waitTextSince(Number(wait.dataset.stateSince));
  }
}

export function refreshCalmView() {
  if (settleArmedAdvance()) return;
  const rows = readRows();
  forgetRemovedSessionStatuses();
  const activeSurface = surface;
  if (!activeSurface || (activeSurface.kind === 'desktop' && isPhoneLayout())) return;
  const home = el('div', 'calm-home');
  home.append(buildRings(rows, activeSurface));
  home.append(activeSurface.kind === 'phone' ? buildPhoneNowList(rows) : buildDesktopNowList(rows));
  const footer = el('footer', 'calm-footer', FOOTER_TEXT_BY_SURFACE[activeSurface.kind]);
  const nextField = el('div', 'calm-field');
  nextField.append(buildTierHeader(rows), home, footer);
  const focusedId = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.sessionId : null;
  field?.remove();
  field = nextField;
  field.inert = panel !== null;
  activeSurface.root.prepend(field);
  if (focusedId && !panel) findLight(focusedId)?.focus();
  if (!selectedSessionId) return;
  const selectedRow = rows.find((row) => row.id === selectedSessionId);
  if (!selectedRow) { closePanel(); return; }
  const ui = sessionUIs.get(selectedSessionId);
  if (JSON.stringify([selectedRow, ui?.planReviewState]) !== selectedFingerprint) openPanel(selectedRow);
}

function openTerminalFromQueue(sessionId: string) {
  const activeSurface = surface;
  if (!activeSurface) return;
  activeSurface.navigation.openTerminal(sessionId);
  if (activeSurface.kind !== 'desktop' || uiState.snapshot().focusedSessionId !== sessionId) return;
  openedFromQueueSessionId = sessionId;
}

function openPanelAtLight(row: CalmRow) {
  openPanel(row);
  opener = findLight(row.id);
}

export function openCalmPanelForSession(sessionId: string) {
  openDesktopCalm();
  if (!isDesktopSurfaceActive()) return false;
  const row = readRows().find((entry) => entry.id === sessionId);
  if (!row) return false;
  openPanelAtLight(row);
  return true;
}

export function openSelectedPanelTerminal() {
  if (!isDesktopSurfaceActive() || !panel || !selectedSessionId) return false;
  openTerminalFromQueue(selectedSessionId);
  return true;
}

export function openNextQueuePanel() {
  if (!isDesktopSurfaceActive()) return false;
  const rows = readRows();
  const nextSessionId = pickNextQueueSessionId(rows, selectedSessionId ?? queueCursorSessionId);
  const nextRow = rows.find((row) => row.id === nextSessionId);
  if (!nextRow) return false;
  queueCursorSessionId = nextRow.id;
  openPanelAtLight(nextRow);
  return true;
}

function advanceAfterReply(repliedSessionId: string) {
  const nextSessionId = pickSessionAfterSubmit(repliedSessionId, openedFromQueueSessionId, readRows());
  if (!nextSessionId) return false;
  openedFromQueueSessionId = null;
  openCalmPanelForSession(nextSessionId);
  return true;
}

function settleArmedAdvance() {
  if (!armedAdvance) return false;
  const ui = sessionUIs.get(armedAdvance.sessionId);
  const armedSession = ui ? { state: ui.currentState, stateSince: ui.stateSince, pendingPromptSummary: ui.pendingPromptDetail?.summary } : null;
  const decision = decideArmedAdvance(armedAdvance, armedSession, Date.now(), armedAdvance.hasOtherInputArrived);
  if (decision === 'keep') return false;
  const repliedSessionId = armedAdvance.sessionId;
  armedAdvance = null;
  if (decision === 'cancel' || isPhoneLayout()) return false;
  return advanceAfterReply(repliedSessionId);
}

function armAdvanceAfterSubmit(submittedSessionId: string) {
  const ui = sessionUIs.get(submittedSessionId);
  if (!ui || isPhoneLayout() || submittedSessionId !== openedFromQueueSessionId) return;
  armedAdvance = { sessionId: submittedSessionId, armedAtMs: Date.now(), armedStateSince: ui.stateSince, armedPromptSummary: ui.pendingPromptDetail?.summary, hasOtherInputArrived: false };
}

function noteTerminalInput(sessionId: string, isSubmit: boolean) {
  if (isSubmit) { armAdvanceAfterSubmit(sessionId); return; }
  if (armedAdvance?.sessionId !== sessionId) return;
  armedAdvance.hasOtherInputArrived = true;
  settleArmedAdvance();
}

export function clearQueueOrigin() {
  openedFromQueueSessionId = null;
  armedAdvance = null;
}

function refreshNowPeekWait() {
  if (!nowPeek || nowPeek.card.hidden) return;
  nowPeek.wait.textContent = nowPeekStateSince === null ? '' : `waiting ${formatWaitTime(Date.now() - nowPeekStateSince)}`;
}

export function mountNowPeek(host: HTMLElement) {
  const card = el('div', 'focus-now-peek');
  card.hidden = true;
  const details = el('span', 'focus-now-peek-details');
  details.id = 'focus-now-peek-details';
  const glyph = el('span', 'focus-now-peek-glyph', glyphByTier.now);
  glyph.setAttribute('aria-hidden', 'true');
  const name = el('span', 'focus-now-peek-name');
  const context = el('span', 'focus-now-peek-context');
  const wait = el('span', 'focus-now-peek-wait');
  details.append(glyph, name, context, wait);
  const openButton = createButton('Open in Calm', 'focus-now-peek-open', () => {
    if (nowPeekSessionId) openCalmPanelForSession(nowPeekSessionId);
  });
  openButton.setAttribute('aria-describedby', details.id);
  card.append(details, openButton);
  host.append(card);
  nowPeek = { card, name, context, wait };
  onSessionTick(refreshNowPeekWait);
}

export function refreshNowPeek(isShown: boolean, focusedSessionId: string | null) {
  if (!nowPeek) return;
  const peekRow = isShown ? pickNowPeek(readRows(), focusedSessionId) : null;
  nowPeek.card.hidden = !peekRow;
  nowPeekSessionId = peekRow?.id ?? null;
  nowPeekStateSince = peekRow?.stateSince ?? null;
  if (!peekRow) return;
  nowPeek.name.textContent = peekRow.name;
  nowPeek.context.textContent = panelContextFor(peekRow, pickComponent(peekRow).component);
  refreshNowPeekWait();
}

function isAnotherDialogOpen() {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"], .dialog-overlay')]
    .some((dialog) => dialog !== panel && dialog.getClientRects().length > 0);
}

export function mountCalmView(element: HTMLElement, { openCalm, ...navigation }: CalmNavigation & { openCalm: () => void }) {
  desktopSurface = { kind: 'desktop', root: element, navigation };
  openDesktopCalm = openCalm;
  new ResizeObserver(() => refreshCalmView()).observe(element);
  onTerminalInput(noteTerminalInput);
  onSessionTick(refreshNowRowWaits);
  uiState.subscribe((state, changedKeys) => {
    const hasLeftFocusView = changedKeys.includes('activeView') && state.activeView !== 'focus';
    const hasFocusMovedOffArmedSession = changedKeys.includes('focusedSessionId') && state.focusedSessionId !== armedAdvance?.sessionId;
    if (hasLeftFocusView || hasFocusMovedOffArmedSession) armedAdvance = null;
    if (!changedKeys.includes('focusedSessionId') || state.focusedSessionId === openedFromQueueSessionId) return;
    openedFromQueueSessionId = null;
  });
  document.addEventListener('keydown', (event) => {
    if (!isDesktopSurfaceActive() || !panel || event.isComposing || event.key !== 'Escape') return;
    const isFromPanelOrBody = event.target === document.body || (event.target instanceof Node && panel.contains(event.target));
    if (!isFromPanelOrBody || isAnotherDialogOpen()) return;
    event.preventDefault();
    dismissPanel();
  });
}

export function activateCalmView() {
  if (!desktopSurface || surface?.kind === 'phone') return;
  surface = desktopSurface;
  refreshCalmView();
}

export function deactivateCalmView() {
  if (surface?.kind !== 'desktop') return;
  closePanel();
  surface = null;
}

export function activatePhoneCalmView(element: HTMLElement, navigation: CalmNavigation) {
  if (surface?.kind !== 'phone' || surface.root !== element) {
    closePanel();
    surface = { kind: 'phone', root: element, navigation };
  }
  refreshCalmView();
}

export function dismissPhoneCalmSheet() {
  if (surface?.kind !== 'phone' || !panel) return;
  dismissPanel();
}

export function deactivatePhoneCalmView() {
  if (surface?.kind !== 'phone') return;
  closePanel();
  surface = null;
}
