import { el, query, stateChip } from './dom-helpers.ts';
import type { SessionUi } from './session-card/card-registry.ts';
import { sessionElapsedText } from './session-card/session-tick.ts';
import { SIGNAL_TIER } from './signal-core.ts';
import type { Signal } from './signal-core.ts';
import { paintSignalLine } from './signal.ts';
import { CLOSE_ICON_PATH, createLineIcon } from './svg-dom.ts';
import type { ActivatableSignal } from './signal.ts';

export type SessionRowRefs = ReturnType<typeof buildSessionRow>['refs'];
type SessionRowSignalSource = (sessionId: string) => ActivatableSignal[];
const sessionRowSignalSources: SessionRowSignalSource[] = [];

const PLAN_PROMPT_KIND = 'plan';

const MERGE_SIGNALS: Readonly<Record<string, Omit<Signal, 'key'>>> = {
  parked: { text: 'PARKED', hoverText: 'Merge parked', look: { icon: 'failed', tone: 'danger' }, tier: SIGNAL_TIER.broken },
  merging: { text: 'MERGING', hoverText: 'Merging', look: { icon: 'queued', tone: 'wait' }, tier: SIGNAL_TIER.waiting },
};

export function addSessionRowSignalSource(source: SessionRowSignalSource) {
  sessionRowSignalSources.push(source);
}

function mergeSignals(mergeStatus: string): ActivatableSignal[] {
  const mergeSignal = MERGE_SIGNALS[mergeStatus];
  return mergeSignal ? [{ ...mergeSignal, key: 'merge' }] : [];
}

function paintSessionRowSignals(slot: HTMLElement) {
  const row = slot.closest<HTMLElement>('.session-row');
  const sessionId = row?.dataset.id;
  if (!row || !sessionId) return;
  const signals = [...mergeSignals(row.dataset.merge ?? ''), ...sessionRowSignalSources.flatMap((source) => source(sessionId))];
  paintSignalLine(slot, signals);
}

export function repaintSessionRowSignals() {
  for (const slot of document.querySelectorAll<HTMLElement>('.session-row-signals')) paintSessionRowSignals(slot);
}

export function buildSessionRow<Tag extends 'button' | 'div'>(tagName: Tag, extraClassName = '') {
  const row = el(tagName, `session-row ${extraClassName}`.trim());
  row.innerHTML = '<span class="session-row-glyph" aria-hidden="true"></span>'
    + '<span class="session-row-main">'
    + '<span class="session-row-name"></span>'
    + '<span class="session-row-meta">'
    + '<span class="session-row-label"></span>'
    + '<span class="session-row-signals" hidden></span>'
    + '</span></span>'
    + '<span class="session-row-elapsed" aria-hidden="true"></span>';
  const refs = {
    glyph: query(row, '.session-row-glyph'),
    label: query(row, '.session-row-label'),
    name: query(row, '.session-row-name'),
    signals: query(row, '.session-row-signals'),
    elapsed: query(row, '.session-row-elapsed'),
  };
  return { row, refs };
}

export function wrapSessionRow(row: HTMLElement, onRemove: () => void) {
  const item = el('div', 'session-row-item');
  const removeButton = el('button', 'session-row-remove');
  removeButton.append(createLineIcon(CLOSE_ICON_PATH));
  removeButton.type = 'button';
  removeButton.title = 'Remove session';
  removeButton.setAttribute('aria-label', 'Remove session');
  removeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    onRemove();
  });
  item.append(row, removeButton);
  return { item, removeButton };
}

export function paintSessionRowStatus(
  row: HTMLElement,
  refs: Pick<SessionRowRefs, 'glyph' | 'label'>,
  state: string,
  awaitingBackgroundTasks = false,
  pendingPromptKind: string | null = null,
) {
  row.dataset.state = state;
  row.dataset.prompt = pendingPromptKind ?? '';
  const { glyph, label, isMonitoring } = stateChip(state, awaitingBackgroundTasks);
  const statusLabel = pendingPromptKind === PLAN_PROMPT_KIND ? 'Plan ready' : label;
  row.toggleAttribute('data-monitoring', isMonitoring);
  refs.glyph.textContent = glyph;
  refs.label.textContent = statusLabel;
  return statusLabel;
}

export function paintSessionRow(
  row: HTMLElement,
  refs: SessionRowRefs,
  { ui, state, name, unseen, mergeStatus }: { ui: SessionUi; state: string; name: string; unseen: boolean; mergeStatus: string },
) {
  row.toggleAttribute('data-unseen', unseen);
  const statusLabel = paintSessionRowStatus(row, refs, state, ui.awaitingBackgroundTasks, ui.pendingPromptKind);
  refs.name.textContent = ui.taskTitle || name;
  row.dataset.merge = mergeStatus;
  paintSessionRowSignals(refs.signals);
  row.dataset.activity = ui._activity || '';
  refs.elapsed.textContent = sessionElapsedText(ui);
  const accessibleLabel = [name, ui.taskTitle, statusLabel].filter(Boolean).join(', ');
  row.setAttribute('aria-label', accessibleLabel);
  row.title = accessibleLabel;
  return statusLabel;
}
