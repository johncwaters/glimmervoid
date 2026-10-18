import { COHERENCE_JOURNAL_DRAWER_MAX_ROWS, type SessionCoherence } from '#shared/contracts/coherence.ts';
import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { CoherenceHooksState } from '#shared/contracts/session.ts';
import { el } from '../dom-helpers.ts';
import { createRequestPanelLifecycle } from './coherence-panel-shell.ts';
import type { ActivatableSignal } from '../signal.ts';
import { coherenceRowSignals, formatCoherenceReading, formatJournalEntry } from './journal-core.ts';

const coherenceBySessionId = new Map<string, SessionCoherence>();
const hooksBySessionId = new Map<string, CoherenceHooksState>();

const journalDrawers = createRequestPanelLifecycle<{ reading: HTMLElement; entries: HTMLElement }>({
  requestPrefix: 'coherence-journal',
  dialogClass: 'dialog coherence-journal-drawer',
  titleText: 'Coherence journal',
  unavailableLabel: 'Journal unavailable',
  timeoutMs: 5000,
});

export function setSessionCoherenceHooks(sessionId: string, hooks: CoherenceHooksState | null) {
  hooksBySessionId.delete(sessionId);
  if (hooks) hooksBySessionId.set(sessionId, hooks);
  paintOpenReading(sessionId);
}

export function forgetSessionCoherence(sessionId: string) {
  coherenceBySessionId.delete(sessionId);
  hooksBySessionId.delete(sessionId);
  const openDrawer = journalDrawers.currentPanel();
  if (openDrawer?.sessionId === sessionId) openDrawer.close();
}

export function applySessionCoherence(message: ServerMessageOf<'session-coherence'>) {
  const previous = coherenceBySessionId.get(message.id);
  if (previous && previous.updatedAt > message.updatedAt) return;
  coherenceBySessionId.set(message.id, message);
  paintOpenReading(message.id);
}

export function applySessionCoherenceSnapshot(message: ServerMessageOf<'session-coherence-snapshot'>) {
  coherenceBySessionId.clear();
  for (const [sessionId, coherence] of Object.entries(message.sessions)) coherenceBySessionId.set(sessionId, coherence);
  const openDrawer = journalDrawers.currentPanel();
  if (openDrawer) paintOpenReading(openDrawer.sessionId);
}

export function sessionRowCoherenceSignals(sessionId: string): ActivatableSignal[] {
  const signals = coherenceRowSignals(hooksBySessionId.get(sessionId) ?? null);
  return signals.map((signal) => ({ ...signal, onActivate: () => openCoherenceJournal(sessionId) }));
}

export function isSessionJournalReadable(sessionId: string): boolean {
  return coherenceBySessionId.get(sessionId)?.journal.ok === true;
}

function paintOpenReading(sessionId: string) {
  const openDrawer = journalDrawers.currentPanel();
  if (!openDrawer || openDrawer.sessionId !== sessionId) return;
  const reading = formatCoherenceReading(hooksBySessionId.get(sessionId) ?? null, coherenceBySessionId.get(sessionId) ?? null);
  openDrawer.parts.reading.replaceChildren(...reading.lines.map((line) => el('p', null, line)));
  if (reading.command) openDrawer.parts.reading.append(el('pre', 'coherence-command', reading.command));
}

export function openCoherenceJournal(sessionId: string) {
  const reading = el('div', 'coherence-journal-reading');
  const status = el('p', 'coherence-journal-status', 'Loading journal');
  status.setAttribute('role', 'status');
  const entries = el('div', 'coherence-journal-entries');
  journalDrawers.open({
    sessionId,
    status,
    body: [reading, status, entries],
    parts: { reading, entries },
    paintBeforeRequest: () => paintOpenReading(sessionId),
    buildRequest: (requestId) => ({ type: 'session-coherence-journal', id: sessionId, requestId }),
  });
}

export function applyCoherenceJournalResponse(message: ServerMessageOf<'session-coherence-journal-response'>) {
  const drawer = journalDrawers.settleResponse(message);
  if (!drawer) return;
  if (!message.ok) {
    drawer.status.textContent = `Journal unavailable: ${message.error || 'could not read journal'}`;
    return;
  }
  drawer.status.textContent = message.entries.length === 0 ? 'No journal entries' : `${message.entries.length} journal entries (up to ${COHERENCE_JOURNAL_DRAWER_MAX_ROWS})`;
  drawer.parts.entries.replaceChildren(...message.entries.map((entry) => {
    const formatted = formatJournalEntry(entry);
    const article = el('article', 'coherence-journal-entry');
    article.append(el('h4', null, formatted.heading), el('p', null, formatted.text));
    if (formatted.detail) article.append(el('p', null, formatted.detail));
    if (formatted.supersedes) article.append(el('p', null, formatted.supersedes));
    return article;
  }));
}
