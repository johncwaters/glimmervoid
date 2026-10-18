import { COHERENCE_JOURNAL_DRAWER_MAX_ROWS, type SessionCoherence } from '#shared/contracts/coherence.ts';
import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { CoherenceHooksState } from '#shared/contracts/session.ts';
import { nextRequestId, sendControlMsg } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { openCoherencePanelShell } from './coherence-panel-shell.ts';
import { coherenceRowLine, formatCoherenceReading, formatJournalEntry } from './journal-core.ts';

const coherenceBySessionId = new Map<string, SessionCoherence>();
const hooksBySessionId = new Map<string, CoherenceHooksState>();

interface JournalDrawer {
  sessionId: string;
  requestId: string | null;
  status: HTMLElement;
  reading: HTMLElement;
  entries: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
  close: () => void;
}

let openDrawer: JournalDrawer | null = null;

export function setSessionCoherenceHooks(sessionId: string, hooks: CoherenceHooksState | null) {
  hooksBySessionId.delete(sessionId);
  if (hooks) hooksBySessionId.set(sessionId, hooks);
  paintOpenReading(sessionId);
}

export function forgetSessionCoherence(sessionId: string) {
  coherenceBySessionId.delete(sessionId);
  hooksBySessionId.delete(sessionId);
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
  if (openDrawer) paintOpenReading(openDrawer.sessionId);
}

export function buildSessionCoherenceLine(sessionId: string) {
  const line = el('div', 'coherence-row-line');
  const button = el('button', 'coherence-journal-button', 'Journal');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.addEventListener('click', () => openCoherenceJournal(sessionId));
  line.append(button, el('span', 'coherence-row-summary'));
  line.hidden = true;
  return line;
}

export function paintSessionCoherenceLine(row: HTMLElement) {
  const sessionId = row.dataset.id;
  const line = row.parentElement?.querySelector<HTMLElement>('.coherence-row-line');
  if (!sessionId || !line) return;
  const hooks = hooksBySessionId.get(sessionId) ?? null;
  const coherence = coherenceBySessionId.get(sessionId) ?? null;
  line.hidden = !hooks && !coherence;
  const summary = line.querySelector('.coherence-row-summary');
  if (summary) summary.textContent = coherenceRowLine(hooks, coherence) ?? '';
}

function paintOpenReading(sessionId: string) {
  if (!openDrawer || openDrawer.sessionId !== sessionId) return;
  const reading = formatCoherenceReading(hooksBySessionId.get(sessionId) ?? null, coherenceBySessionId.get(sessionId) ?? null);
  openDrawer.reading.replaceChildren(...reading.lines.map((line) => el('p', null, line)));
  if (reading.command) openDrawer.reading.append(el('pre', 'coherence-command', reading.command));
}

function openCoherenceJournal(sessionId: string) {
  openDrawer?.close();
  const requestId = nextRequestId('coherence-journal');
  const reading = el('div', 'coherence-journal-reading');
  const status = el('p', 'coherence-journal-status', 'Loading journal');
  status.setAttribute('role', 'status');
  const entries = el('div', 'coherence-journal-entries');
  const shell = openCoherencePanelShell({
    dialogClass: 'dialog coherence-journal-drawer',
    titleText: 'Coherence journal',
    titleId: `${requestId}-title`,
    body: [reading, status, entries],
    onCloseRequest: () => drawer.close(),
  });

  const drawer: JournalDrawer = {
    sessionId, requestId, status, reading, entries, timer: null,
    close: () => {
      if (drawer.timer !== null) clearTimeout(drawer.timer);
      drawer.requestId = null;
      if (openDrawer === drawer) openDrawer = null;
      shell.close();
    },
  };
  openDrawer = drawer;
  paintOpenReading(sessionId);
  shell.focusClose();

  if (!sendControlMsg({ type: 'session-coherence-journal', id: sessionId, requestId })) {
    drawer.requestId = null;
    status.textContent = 'Journal unavailable: not connected';
    return;
  }
  drawer.timer = setTimeout(() => {
    drawer.requestId = null;
    drawer.timer = null;
    status.textContent = 'Journal unavailable: request timed out';
  }, 5000);
}

export function applyCoherenceJournalResponse(message: ServerMessageOf<'session-coherence-journal-response'>) {
  const drawer = openDrawer;
  if (!drawer || drawer.sessionId !== message.id || drawer.requestId === null || drawer.requestId !== message.requestId) return;
  if (drawer.timer !== null) clearTimeout(drawer.timer);
  drawer.timer = null;
  drawer.requestId = null;
  if (!message.ok) {
    drawer.status.textContent = `Journal unavailable: ${message.error || 'could not read journal'}`;
    return;
  }
  drawer.status.textContent = message.entries.length === 0 ? 'No journal entries' : `${message.entries.length} journal entries (up to ${COHERENCE_JOURNAL_DRAWER_MAX_ROWS})`;
  drawer.entries.replaceChildren(...message.entries.map((entry) => {
    const formatted = formatJournalEntry(entry);
    const article = el('article', 'coherence-journal-entry');
    article.append(el('h4', null, formatted.heading), el('p', null, formatted.text));
    if (formatted.detail) article.append(el('p', null, formatted.detail));
    if (formatted.supersedes) article.append(el('p', null, formatted.supersedes));
    return article;
  }));
}
