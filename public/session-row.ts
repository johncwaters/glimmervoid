import { el, MERGE_TAGS, query, stateChip } from './dom-helpers.ts';
import type { SessionUi } from './session-card/card-registry.ts';
import { sessionElapsedText } from './session-card/session-tick.ts';

export type SessionRowRefs = ReturnType<typeof buildSessionRow>['refs'];
type PrChipsPainter = (slot: HTMLElement, sessionId: string) => void;
let paintSessionRowPrChips: PrChipsPainter | null = null;
interface CoherenceLinePainter {
  build: (sessionId: string) => HTMLElement;
  paint: (row: HTMLElement) => void;
}
let sessionRowCoherenceLine: CoherenceLinePainter | null = null;

const PLAN_PROMPT_KIND = 'plan';

export function setSessionRowPrChipsPainter(painter: PrChipsPainter) {
  paintSessionRowPrChips = painter;
}

export function setSessionRowCoherenceLinePainter(painter: CoherenceLinePainter) {
  sessionRowCoherenceLine = painter;
}

export function buildSessionRow<Tag extends 'button' | 'div'>(tagName: Tag, extraClassName = '') {
  const row = el(tagName, `session-row ${extraClassName}`.trim());
  row.innerHTML = '<span class="session-row-glyph" aria-hidden="true"></span>'
    + '<span class="session-row-main">'
    + '<span class="session-row-name"></span>'
    + '<span class="session-row-meta">'
    + '<span class="session-row-label"></span><span class="session-row-merge"></span>'
    + '<span class="session-pr-chips session-row-prs" hidden></span>'
    + '</span></span>'
    + '<span class="session-row-elapsed" aria-hidden="true"></span>';
  const refs = {
    glyph: query(row, '.session-row-glyph'),
    label: query(row, '.session-row-label'),
    name: query(row, '.session-row-name'),
    merge: query(row, '.session-row-merge'),
    prs: query(row, '.session-row-prs'),
    elapsed: query(row, '.session-row-elapsed'),
  };
  return { row, refs };
}

export function wrapSessionRow(row: HTMLElement, onRemove: () => void) {
  const item = el('div', 'session-row-item');
  const removeButton = el('button', 'session-row-remove', 'x');
  removeButton.type = 'button';
  removeButton.title = 'Remove session';
  removeButton.setAttribute('aria-label', 'Remove session');
  removeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    onRemove();
  });
  item.append(row, removeButton);
  if (sessionRowCoherenceLine) item.append(sessionRowCoherenceLine.build(row.dataset.id ?? ''));
  return { item, removeButton };
}

export function paintSessionRowStatus(
  row: HTMLElement,
  refs: Pick<SessionRowRefs, 'glyph' | 'label'> & Partial<Pick<SessionRowRefs, 'prs'>>,
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
  if (refs.prs && row.dataset.id) paintSessionRowPrChips?.(refs.prs, row.dataset.id);
  return statusLabel;
}

export function paintSessionRow(
  row: HTMLElement,
  refs: SessionRowRefs,
  { ui, state, name, unseen, mergeStatus }: { ui: SessionUi; state: string; name: string; unseen: boolean; mergeStatus: string },
) {
  row.toggleAttribute('data-unseen', unseen);
  const statusLabel = paintSessionRowStatus(row, refs, state, ui.awaitingBackgroundTasks, ui.pendingPromptKind);
  refs.name.textContent = name;
  refs.name.append(el('span', 'session-list-task-title', ui.taskTitle ?? ''));
  row.dataset.merge = mergeStatus;
  refs.merge.textContent = MERGE_TAGS[mergeStatus] || '';
  row.dataset.activity = ui._activity || '';
  refs.elapsed.textContent = sessionElapsedText(ui);
  sessionRowCoherenceLine?.paint(row);
  const accessibleLabel = [name, ui.taskTitle, statusLabel].filter(Boolean).join(', ');
  row.setAttribute('aria-label', accessibleLabel);
  row.title = accessibleLabel;
  return statusLabel;
}
