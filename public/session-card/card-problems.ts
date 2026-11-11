import { STATES } from '#shared/states.ts';
import { ManagerDecision } from '#shared/contracts/question-manager.ts';
import type { AttentionNote } from '#shared/contracts/session.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { answersAckSeq, decisionsAfter, managerDecisionText, passedOnReason, unseenAnswers } from '../focus-view/attention-core.ts';
import { markStatusDirty } from '../status-paint.ts';
import { uiState } from '../ui-state-core.ts';
import { sessionActionStatus } from './card-actions.ts';
import { findSessionUi } from './card-registry.ts';
import { reportHeaderError } from '../action-status.ts';
import { clock } from '#shared/clock.ts';

export function reportSessionProblem(sessionId: unknown, message: string) {
  const ui = findSessionUi(sessionId);
  if (!ui) { reportHeaderError({ source: 'Session', sessionId: typeof sessionId === 'string' ? sessionId : undefined, message }); return; }
  sessionActionStatus(ui).show('error', message);
}

export function setSessionFailureReason(sessionId: unknown, failureReason: string | null | undefined) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  const existingLine = ui.card.querySelector<HTMLElement>(':scope > .session-failure-reason');
  const shouldShow = ui.currentState === STATES.FAILED && !!failureReason;
  if (!shouldShow) {
    existingLine?.remove();
    return;
  }
  const reasonLine = existingLine ?? el('p', 'session-failure-reason');
  reasonLine.setAttribute('role', 'status');
  reasonLine.textContent = failureReason;
  if (!existingLine) ui.termWrap.before(reasonLine);
}

const attentionNotesDismissedThroughBySessionId = new Map<string, number>();

export function setSessionAttentionNotes(sessionId: string, notes: readonly AttentionNote[]) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  const existingLine = ui.card.querySelector<HTMLElement>(':scope > .session-attention-note');
  const newestNote = notes[0];
  const dismissedThrough = attentionNotesDismissedThroughBySessionId.get(sessionId) ?? 0;
  if (!newestNote || newestNote.at <= dismissedThrough) {
    existingLine?.remove();
    return;
  }
  const line = existingLine ?? buildAttentionNoteLine(sessionId);
  line.dataset.newestAt = String(newestNote.at);
  const text = line.querySelector<HTMLElement>('.session-attention-note-text');
  if (text) text.textContent = newestNote.note;
  const others = line.querySelector<HTMLElement>('.session-attention-note-others');
  if (others) others.textContent = notes.length > 1 ? `${notes.length - 1} more` : '';
  if (!existingLine) ui.termWrap.before(line);
}

export function forgetAttentionNotes(sessionId: string) {
  attentionNotesDismissedThroughBySessionId.delete(sessionId);
}

function buildAttentionNoteLine(sessionId: string): HTMLElement {
  const line = el('div', 'session-attention-note');
  line.setAttribute('role', 'status');
  const dismissButton = button({
    variant: 'quiet',
    size: 'small',
    label: 'Dismiss',
    onClick: () => {
      attentionNotesDismissedThroughBySessionId.set(sessionId, Number(line.dataset.newestAt ?? 0));
      line.remove();
    },
  });
  line.append(el('p', 'session-attention-note-text'), el('span', 'session-attention-note-others'), dismissButton);
  return line;
}

const MANAGER_DECISIONS_KEPT = 200;
const managerDecisionsBySessionId = new Map<string, ManagerDecision[]>();
const managerSeenSeqBySessionId = new Map<string, number>();
const lineSeenSeqBySessionId = new Map<string, number>();

function managerDecisionsFor(sessionId: string): readonly ManagerDecision[] {
  return managerDecisionsBySessionId.get(sessionId) ?? [];
}

function managerSeenSeqFor(sessionId: string): number {
  return managerSeenSeqBySessionId.get(sessionId) ?? 0;
}

export function unseenManagerAnswersFor(sessionId: string): ManagerDecision[] {
  return unseenAnswers(managerDecisionsFor(sessionId), managerSeenSeqFor(sessionId));
}

export function passedOnReasonFor(sessionId: string): string | null {
  return passedOnReason(managerDecisionsFor(sessionId), managerSeenSeqFor(sessionId));
}

export function seedManagerDecisions(sessionId: string, auditLog: readonly unknown[], managerSeenSeq: number) {
  const decisions = auditLog.flatMap((entry) => {
    const parsed = ManagerDecision.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  managerDecisionsBySessionId.set(sessionId, decisions.slice(-MANAGER_DECISIONS_KEPT));
  managerSeenSeqBySessionId.set(sessionId, managerSeenSeq);
}

export function addManagerDecision(sessionId: string, decision: ManagerDecision) {
  const decisions = managerDecisionsBySessionId.get(sessionId) ?? [];
  if ((decisions.at(-1)?.seq ?? 0) >= decision.seq) return;
  managerDecisionsBySessionId.set(sessionId, [...decisions, decision].slice(-MANAGER_DECISIONS_KEPT));
}

export function setManagerSeenSeq(sessionId: string, managerSeenSeq: number) {
  managerSeenSeqBySessionId.set(sessionId, managerSeenSeq);
}

export function forgetManagerDecisions(sessionId: string) {
  managerDecisionsBySessionId.delete(sessionId);
  managerSeenSeqBySessionId.delete(sessionId);
  closeManagerDecisionLine(sessionId);
}

export function markManagerAnswersSeen(sessionId: string, listedThroughSeq: number) {
  markManagerDecisionsSeen(sessionId, answersAckSeq(managerDecisionsFor(sessionId), managerSeenSeqFor(sessionId), listedThroughSeq));
}

function markManagerDecisionsSeen(sessionId: string, throughSeq = managerDecisionsFor(sessionId).at(-1)?.seq ?? 0) {
  if (throughSeq <= managerSeenSeqFor(sessionId)) return;
  managerSeenSeqBySessionId.set(sessionId, throughSeq);
  sendControlMsg({ type: 'manager-seen', id: sessionId, throughSeq });
  markStatusDirty(sessionId);
}

export function openManagerDecisionLine(sessionId: string) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  const lineSeenSeq = lineSeenSeqBySessionId.get(sessionId) ?? managerSeenSeqFor(sessionId);
  const unseenDecisions = decisionsAfter(managerDecisionsFor(sessionId), lineSeenSeq);
  markManagerDecisionsSeen(sessionId);
  const latestUnseen = unseenDecisions.at(-1);
  if (!latestUnseen) return;
  lineSeenSeqBySessionId.set(sessionId, lineSeenSeq);
  const existingLine = ui.card.querySelector<HTMLElement>(':scope > .session-manager-line');
  const line = existingLine ?? buildManagerDecisionLine(sessionId);
  const summary = line.querySelector<HTMLElement>('.session-manager-line-text');
  if (summary) summary.textContent = managerDecisionText(latestUnseen);
  const earlierCount = unseenDecisions.length - 1;
  const earlier = line.querySelector<HTMLElement>('.session-manager-line-earlier');
  if (earlier) earlier.textContent = earlierCount > 0 ? `${earlierCount} earlier` : '';
  if (!existingLine) ui.termWrap.before(line);
}

function buildManagerDecisionLine(sessionId: string): HTMLElement {
  const line = el('div', 'session-manager-line');
  line.setAttribute('role', 'status');
  const history = el('ol', 'session-manager-history');
  history.hidden = true;
  const historyButton = button({
    variant: 'quiet',
    size: 'small',
    label: 'History',
    onClick: () => {
      const shouldOpen = history.hidden;
      history.hidden = !shouldOpen;
      historyButton.setAttribute('aria-expanded', String(shouldOpen));
      if (shouldOpen) fillManagerHistory(history, sessionId);
    },
  });
  historyButton.classList.add('session-manager-line-history');
  historyButton.setAttribute('aria-expanded', 'false');
  line.append(el('p', 'session-manager-line-text'), el('span', 'session-manager-line-earlier'), historyButton, history);
  return line;
}

function fillManagerHistory(history: HTMLElement, sessionId: string) {
  const items = [...managerDecisionsFor(sessionId)].reverse().map((decision) => {
    const item = el('li', null, managerDecisionText(decision));
    const time = el('time', 'session-manager-history-time', clock.format(decision.ts, 'short-time'));
    time.dateTime = new Date(decision.ts).toISOString();
    item.prepend(time);
    return item;
  });
  history.replaceChildren(...items);
}

function closeManagerDecisionLine(sessionId: string) {
  lineSeenSeqBySessionId.delete(sessionId);
  findSessionUi(sessionId)?.card.querySelector(':scope > .session-manager-line')?.remove();
}

uiState.subscribe((state, _changedKeys, previousState) => {
  for (const leftSessionId of [previousState.focusedSessionId, previousState.borrowedCardId]) {
    if (!leftSessionId || leftSessionId === state.focusedSessionId || leftSessionId === state.borrowedCardId) continue;
    closeManagerDecisionLine(leftSessionId);
  }
});
