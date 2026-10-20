import { STATES } from '#shared/states.ts';
import { borrowCard, getBorrowedCardId, releaseCard } from '../card-host.ts';
import { el } from '../dom-helpers.ts';
import { hasUnseenOutcomeAttention, orderAttentionQueue, orderRoster, pickNextAttention, pickStagedSession, stageNeedWords } from '../focus-view/attention-core.ts';
import { basename } from '../focus-view/roster-groups-core.ts';
import { readSessionRows } from '../session-actions.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { markSessionSeen } from '../session-card/lifecycle.ts';
import { setTerminalActiveViewer } from '../session-card/terminal.ts';
import { buildShortcutKeys, SHORTCUT_PLATFORM } from '../shortcuts.ts';
import { shortcutChord } from '../shortcuts-core.ts';

const WORKING_STATES: ReadonlySet<string> = new Set([STATES.RUNNING, STATES.STARTING, STATES.INITIALIZING]);

interface ZenElements {
  calm: HTMLElement;
  workingCount: HTMLElement;
  workingList: HTMLUListElement;
  stage: HTMLElement;
  stagedNeed: HTMLElement;
  queuedBehind: HTMLElement;
  cardSlot: HTMLElement;
}

let zenElements: ZenElements | null = null;
let isActive = false;
let stagedSessionId: string | null = null;

export function mountZenView(panel: HTMLElement) {
  const calm = el('div', 'zen-calm');
  const statusLine = el('div', 'zen-status-line');
  statusLine.setAttribute('role', 'status');
  const workingCount = el('span', 'zen-working-count');
  statusLine.append(el('h2', 'zen-all-clear', 'ALL CLEAR'), workingCount);
  const workingList = el('ul', 'zen-working-list');
  workingList.setAttribute('aria-label', 'Working sessions');
  calm.append(statusLine, workingList);

  const stage = el('div', 'zen-stage');
  const reasonLine = el('div', 'zen-reason-line');
  reasonLine.setAttribute('role', 'status');
  const stagedNeed = el('span', 'zen-staged-need');
  const queuedBehind = el('span', 'zen-queued-behind');
  reasonLine.append(stagedNeed, queuedBehind);
  const nextButton = el('button', 'btn-dialog', 'Next');
  nextButton.type = 'button';
  nextButton.addEventListener('click', stageNextAttention);
  const stageBar = el('div', 'zen-stage-bar');
  stageBar.append(reasonLine, nextButton, buildShortcutKeys(shortcutChord('next-attention', SHORTCUT_PLATFORM)));
  const cardSlot = el('div', 'zen-card-slot');
  stage.append(stageBar, cardSlot);
  stage.hidden = true;

  panel.append(calm, stage);
  zenElements = { calm, workingCount, workingList, stage, stagedNeed, queuedBehind, cardSlot };
}

export function isZenActive() { return isActive; }

export function activateZenView() {
  if (!zenElements) return;
  isActive = true;
  refreshZenView();
}

export function deactivateZenView() {
  if (!isActive) return;
  releaseStage();
  isActive = false;
}

export function refreshZenView() {
  if (!isActive) return;
  const queuedIds = queuedSessionIds();
  showStage(pickStagedSession(queuedIds, stagedSessionId), queuedIds);
}

export function stageNextAttention() {
  if (!isActive) return;
  const leavingId = stagedSessionId;
  const leavingUi = leavingId === null ? undefined : sessionUIs.get(leavingId);
  const isLeavingUnseenOutcome = leavingUi !== undefined && hasUnseenOutcomeAttention({ state: leavingUi.currentState, unseenOutcome: leavingUi.unseenOutcome });
  if (leavingId !== null && isLeavingUnseenOutcome) markSessionSeen(leavingId);
  const queuedIds = queuedSessionIds().filter((id) => !isLeavingUnseenOutcome || id !== leavingId);
  const nextId = pickNextAttention(queuedIds, leavingId);
  showStage(nextId, queuedIds);
}

function queuedSessionIds() {
  return orderAttentionQueue(orderRoster(readSessionRows()));
}

function showStage(sessionId: string | null, queuedIds: readonly string[]) {
  if (!zenElements) return;
  const ui = sessionId === null ? undefined : sessionUIs.get(sessionId);
  if (sessionId === null || !ui) {
    releaseStage();
    paintCalm(zenElements);
    return;
  }
  const isNewlyStaged = stagedSessionId !== sessionId;
  stagedSessionId = sessionId;
  zenElements.calm.hidden = true;
  zenElements.stage.hidden = false;
  paintReasonLine(zenElements, ui, queuedIds.filter((id) => id !== sessionId).length);
  if (getBorrowedCardId() === sessionId && ui.card.parentElement === zenElements.cardSlot) return;
  borrowCard(ui, sessionId, zenElements.cardSlot, { className: 'zen-staged' });
  setTerminalActiveViewer(ui, sessionId, true);
  if (isNewlyStaged) focusTerminalAfterSettle(ui, sessionId);
}

function releaseStage() {
  if (stagedSessionId !== null && getBorrowedCardId() === stagedSessionId) releaseCard();
  stagedSessionId = null;
}

function paintReasonLine(elements: ZenElements, ui: SessionUi, queuedBehindCount: number) {
  elements.stagedNeed.textContent = stageNeedWords(ui.currentState, ui.pendingPromptKind);
  elements.stagedNeed.dataset.state = ui.currentState;
  elements.queuedBehind.textContent = `${queuedBehindCount} more waiting`;
  elements.queuedBehind.hidden = queuedBehindCount === 0;
}

function paintCalm(elements: ZenElements) {
  elements.stage.hidden = true;
  elements.calm.hidden = false;
  const workingRows = orderRoster(readSessionRows()).filter((row) => WORKING_STATES.has(row.state));
  elements.workingCount.textContent = `${workingRows.length} working`;
  elements.workingList.replaceChildren(...workingRows.map((row) => {
    const item = el('li', 'zen-working-session');
    const dot = el('span', 'zen-working-dot');
    dot.setAttribute('aria-hidden', 'true');
    item.append(dot, el('span', 'zen-working-name', row.name), el('span', 'zen-working-project', basename(row.ui.path)));
    return item;
  }));
}

function focusTerminalAfterSettle(ui: SessionUi, sessionId: string) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!isActive || stagedSessionId !== sessionId) return;
    if (document.hidden || !document.hasFocus()) return;
    ui.term?.focus();
  }));
}
