import './trace-panel.css';
import { buildPanelSection, el, isPanelHidden, query, writeClipboardText } from './dom-helpers.ts';
import { createActionStatus } from './action-status.ts';
import { formatTrailOffset } from './radar/radar-core.ts';
import {
  formatTurnMetrics,
  hasEarlierTracePages,
  isKindHidden,
  shouldRebuildTraceView,
  traceEmptyState,
  traceRecordBody,
  traceSessionStartedAtMs,
  TRACE_FILTERABLE_KINDS,
  toggleHiddenKind,
} from './trace-view-core.ts';
import { getTraceHiddenKinds, setTraceHiddenKinds } from './ui-prefs.ts';
import type { TracePrepend, TraceSessionOption, TraceTurn, TraceTurnAppend, TraceViewRow } from './trace-view-core.ts';
import {
  refreshTraceSelectionOnShow,
  requestEarlierTrace,
  selectTraceSession,
  setTraceLookingProbe,
  subscribeTrace,
  traceEarlierPageInputs,
  traceSnapshot,
} from './trace-store.ts';
import type { TraceChange, TraceTrim } from './trace-store.ts';
import type { ViewModule } from './view-registry-core.ts';

interface TurnSection {
  section: HTMLElement;
  rowsElement: HTMLElement;
  metricsElement: HTMLElement;
}

let rootElement: HTMLDivElement | null = null;
let headerElement: HTMLElement | null = null;
let turnsElement: HTMLElement | null = null;
let loadEarlierControlElement: HTMLElement | null = null;
let turnSections: TurnSection[] = [];
let isRenderedTraceStale = false;
let hiddenTraceKinds = getTraceHiddenKinds();

let isRebuildDueAfterTrim = false;
let pendingPrependLayout: { canPrependInPlace: boolean; scrollElement: HTMLElement | null; previousScrollHeight: number; previousScrollTop: number } | null = null;

function isTraceVisible(): boolean {
  return !!rootElement && !isPanelHidden(rootElement);
}

function selectedSession(): TraceSessionOption | null {
  const { sessionOptions, selectedSessionId } = traceSnapshot();
  return sessionOptions.find((option) => option.id === selectedSessionId) ?? null;
}

function buildSessionSelector(): HTMLLabelElement {
  const field = el('label', 'trace-session-field');
  const label = el('span', 'trace-session-label', 'Session');
  const select = el('select', 'trace-session-select');
  const { sessionOptions, selectedSessionId } = traceSnapshot();
  select.disabled = sessionOptions.length === 0;
  for (const optionValue of sessionOptions) {
    const option = el('option', null, optionValue.label);
    option.value = optionValue.id;
    option.selected = optionValue.id === selectedSessionId;
    select.append(option);
  }
  select.addEventListener('change', () => selectTraceSession(select.value));
  field.append(label, select);
  return field;
}

function applyHiddenKindToRow(rowElement: HTMLElement): void {
  rowElement.toggleAttribute('data-hidden', isKindHidden(hiddenTraceKinds, rowElement.dataset.kind ?? ''));
}

function applyHiddenKindsToTurns(): void {
  if (!turnsElement) return;
  for (const rowElement of turnsElement.querySelectorAll<HTMLElement>('.trace-row')) applyHiddenKindToRow(rowElement);
}

function setRenderedRowsExpanded(isExpanded: boolean): void {
  if (!turnsElement) return;
  for (const details of turnsElement.querySelectorAll<HTMLDetailsElement>('details')) details.open = isExpanded;
}

function buildTraceFilters(): HTMLElement {
  const filters = el('div', 'trace-filters');
  for (const filter of TRACE_FILTERABLE_KINDS) {
    const button = el('button', 'trace-filter', filter.label);
    button.type = 'button';
    const syncPressedState = () => { button.setAttribute('aria-pressed', String(!isKindHidden(hiddenTraceKinds, filter.kind))); };
    syncPressedState();
    button.addEventListener('click', () => {
      hiddenTraceKinds = toggleHiddenKind(hiddenTraceKinds, filter.kind);
      setTraceHiddenKinds(hiddenTraceKinds);
      syncPressedState();
      applyHiddenKindsToTurns();
    });
    filters.append(button);
  }
  for (const [label, isExpanded] of [['Expand all', true], ['Collapse all', false]] as const) {
    const button = el('button', 'trace-expand-control', label);
    button.type = 'button';
    button.addEventListener('click', () => { setRenderedRowsExpanded(isExpanded); });
    filters.append(button);
  }
  return filters;
}

function buildHeader(): HTMLElement {
  const section = buildPanelSection('trace', 'Session trace', 'Bodies load from the local trace file only when requested.');
  const controls = el('div', 'trace-controls');
  const { selectedTrace, traceFailureText } = traceSnapshot();
  controls.append(buildSessionSelector());
  const pathValue = selectedTrace?.filePath ?? '';
  const path = el('code', 'trace-path', pathValue);
  path.title = pathValue;
  controls.append(path);
  const sessionStartedAtMs = selectedTrace
    ? traceSessionStartedAtMs(selectedTrace.firstOffset, selectedTrace.hasDroppedEarliestRows, selectedTrace.grouping.turns[0])
    : null;
  if (sessionStartedAtMs !== null) controls.append(el('span', 'trace-session-start', `Started ${new Date(sessionStartedAtMs).toLocaleString()}`));
  section.append(controls, buildTraceFilters());
  if (!traceFailureText) return section;
  const failureStatus = createActionStatus('trace-status');
  failureStatus.show('error', traceFailureText);
  section.append(failureStatus.element);
  return section;
}

function buildCopyControl(body: string): HTMLElement {
  const wrap = el('div', 'trace-copy-wrap');
  const button = el('button', 'trace-copy', 'Copy');
  button.type = 'button';
  const status = el('span', 'trace-copy-status');
  status.setAttribute('role', 'status');
  button.addEventListener('click', () => {
    const write = writeClipboardText(body);
    if (!write) {
      status.textContent = 'Copy failed';
      return;
    }
    write
      .then(() => { status.textContent = 'Copied'; })
      .catch(() => { status.textContent = 'Copy failed'; });
    setTimeout(() => { status.textContent = ''; }, 1600);
  });
  wrap.append(button, status);
  return wrap;
}

function buildLoadEarlierControl(): HTMLElement {
  const wrap = el('div', 'trace-earlier-wrap');
  const button = el('button', 'trace-load-earlier', 'Load earlier');
  button.type = 'button';
  button.addEventListener('click', () => { requestEarlierTrace(); });
  wrap.append(button);
  return wrap;
}

function buildExpandableRow(row: TraceViewRow, turnStartedAtMs: number | null, className = ''): HTMLDetailsElement {
  const details = el('details', `trace-row${className ? ` ${className}` : ''}`);
  details.dataset.kind = row.kind;
  details.dataset.tone = row.tone;
  applyHiddenKindToRow(details);
  const summary = el('summary', 'trace-row-summary');
  summary.append(
    el('span', 'trace-offset', formatTrailOffset(turnStartedAtMs, row.record.ts)),
    el('span', 'trace-kind', row.tag),
    el('span', 'trace-row-label', row.text),
  );
  for (const badge of row.badges) {
    const badgeElement = el('span', 'trace-badge', badge);
    badgeElement.dataset.badge = badge;
    summary.append(badgeElement);
  }
  const body = el('div', 'trace-row-body');
  details.append(summary, body);
  let hasBody = false;
  details.addEventListener('toggle', () => {
    if (!details.open || hasBody) return;
    hasBody = true;
    const text = traceRecordBody(row.record);
    body.append(buildCopyControl(text), el('pre', 'trace-row-pre', text));
  });
  return details;
}

function buildTurnMetrics(turn: TraceTurn): HTMLElement {
  return el('span', 'trace-turn-metrics', formatTurnMetrics(turn));
}

function paintTurnMetrics(turn: TraceTurn | null | undefined, metricsElement: HTMLElement | undefined): void {
  if (!turn || !metricsElement) return;
  metricsElement.textContent = formatTurnMetrics(turn);
}

function paintTurnRowOffsets(rowsElement: HTMLElement, turn: TraceTurn): void {
  const rowElements = rowsElement.children;
  const paintableRowCount = Math.min(turn.rows.length, rowElements.length);
  for (let rowIndex = 0; rowIndex < paintableRowCount; rowIndex += 1) {
    const offsetElement = rowElements[rowIndex]?.querySelector('.trace-offset');
    if (!offsetElement) continue;
    offsetElement.textContent = formatTrailOffset(turn.startedAt, turn.rows[rowIndex].record.ts);
  }
}

function buildTurnHead(turn: TraceTurn, head: TraceViewRow, metricsElement: HTMLElement): HTMLDetailsElement {
  const turnHeadElement = buildExpandableRow(head, turn.startedAt, 'trace-turn-head');
  query(turnHeadElement, '.trace-row-summary').append(metricsElement);
  return turnHeadElement;
}

function buildTurnSection(turn: TraceTurn): TurnSection {
  const section = el('section', 'trace-turn');
  const metricsElement = buildTurnMetrics(turn);
  if (turn.head) section.append(buildTurnHead(turn, turn.head, metricsElement));
  if (!turn.head) {
    const heading = el('h2', 'trace-leading-title');
    heading.append(el('span', 'trace-leading-label', 'Before first prompt'), metricsElement);
    section.append(heading);
  }
  const rowsElement = el('div', 'trace-rows');
  for (const row of turn.rows) rowsElement.append(buildExpandableRow(row, turn.startedAt));
  if (turn.hasTrimmedRows) section.append(el('p', 'trace-trimmed', 'Earlier rows trimmed'));
  section.append(rowsElement);
  return { section, rowsElement, metricsElement };
}

function emptyStateText(session: TraceSessionOption | null): string {
  if (!session) return traceEmptyState(null);
  const { pendingSessionId, selectedTrace } = traceSnapshot();
  const isFirstPageLoading = pendingSessionId === session.id && !selectedTrace?.hasLoadedOnce;
  return isFirstPageLoading ? 'Loading trace.' : traceEmptyState(session);
}

function buildPanelContent(): void {
  if (!rootElement) return;
  const content = el('div', 'trace-content');
  headerElement = buildHeader();
  content.append(headerElement);
  turnsElement = null;
  loadEarlierControlElement = null;
  turnSections = [];
  const session = selectedSession();
  const turns = traceSnapshot().selectedTrace?.grouping.turns ?? [];
  if (!session || turns.length === 0) {
    content.append(el('p', 'trace-empty', emptyStateText(session)));
    rootElement.replaceChildren(content);
    isRenderedTraceStale = false;
    return;
  }
  if (hasEarlierTracePages(traceEarlierPageInputs())) {
    loadEarlierControlElement = buildLoadEarlierControl();
    content.append(loadEarlierControlElement);
  }
  const list = el('div', 'trace-turns');
  for (const turn of turns) {
    const built = buildTurnSection(turn);
    turnSections.push(built);
    list.append(built.section);
  }
  turnsElement = list;
  applyHiddenKindsToTurns();
  content.append(list);
  rootElement.replaceChildren(content);
  isRenderedTraceStale = false;
}

function renderPanel(): void {
  if (!rootElement) return;
  if (!isTraceVisible()) {
    isRenderedTraceStale = true;
    return;
  }
  buildPanelContent();
}

function renderHeader(): void {
  if (!headerElement || !isTraceVisible()) return;
  const nextHeader = buildHeader();
  headerElement.replaceWith(nextHeader);
  headerElement = nextHeader;
}

function applyTurnAppend(append: TraceTurnAppend): void {
  if (!turnsElement) return;
  const turn = traceSnapshot().selectedTrace?.grouping.turns[append.turnIndex];
  if (!turn) return;
  if (append.isNewTurn) {
    const built = buildTurnSection(turn);
    turnSections.push(built);
    turnsElement.append(built.section);
    return;
  }
  const appendedSection = turnSections[append.turnIndex];
  if (!appendedSection) return;
  for (const row of append.rows) appendedSection.rowsElement.append(buildExpandableRow(row, turn.startedAt));
  paintTurnMetrics(turn, appendedSection.metricsElement);
}

function markTurnRowsTrimmed(rowsElement: HTMLElement): void {
  const section = rowsElement.parentElement;
  if (!section || section.querySelector('.trace-trimmed')) return;
  section.insertBefore(el('p', 'trace-trimmed', 'Earlier rows trimmed'), rowsElement);
}

function syncLoadEarlierControl(): void {
  const shouldShowControl = hasEarlierTracePages(traceEarlierPageInputs());
  if (!shouldShowControl) {
    loadEarlierControlElement?.remove();
    loadEarlierControlElement = null;
    return;
  }
  if (loadEarlierControlElement || !turnsElement?.parentElement) return;
  loadEarlierControlElement = buildLoadEarlierControl();
  turnsElement.parentElement.insertBefore(loadEarlierControlElement, turnsElement);
}

function applyTrimToRenderedTurns(trim: TraceTrim): void {
  const hasDroppedRows = trim.droppedTurnCount > 0 || trim.droppedRowCount > 0;
  if (!hasDroppedRows) {
    syncLoadEarlierControl();
    return;
  }
  turnSections = turnSections.slice(trim.droppedTurnCount);
  if (turnsElement) {
    for (let removedCount = 0; removedCount < trim.droppedTurnCount; removedCount += 1) turnsElement.firstElementChild?.remove();
  }
  const oldestSection = turnSections[0];
  if (oldestSection && trim.droppedRowCount > 0) {
    for (let removedCount = 0; removedCount < trim.droppedRowCount; removedCount += 1) oldestSection.rowsElement.firstElementChild?.remove();
    markTurnRowsTrimmed(oldestSection.rowsElement);
    paintTurnMetrics(traceSnapshot().selectedTrace?.grouping.turns[0], oldestSection.metricsElement);
  }
  if (trim.hasJustDroppedEarliestRows) renderHeader();
  syncLoadEarlierControl();
}

function showAppendedRecords(appends: readonly TraceTurnAppend[]): void {
  const canAppendInPlace = isTraceVisible() && !isRenderedTraceStale && !!turnsElement;
  if (canAppendInPlace) {
    for (const append of appends) applyTurnAppend(append);
    return;
  }
  turnsElement = null;
  isRebuildDueAfterTrim = true;
}

function applyPrependToRenderedTurns(prepend: TracePrepend): void {
  if (!turnsElement) return;
  const firstResidentSection = turnSections[0] ?? null;
  const firstResidentSectionElement = firstResidentSection?.rowsElement.parentElement ?? null;
  const firstResidentTurn = traceSnapshot().selectedTrace?.grouping.turns[prepend.newTurns.length] ?? null;
  if ((prepend.mergedHead || prepend.mergedRows.length > 0) && firstResidentSection && firstResidentSectionElement && firstResidentTurn) {
    const firstResidentRowsElement = firstResidentSection.rowsElement;
    if (prepend.mergedHead) {
      firstResidentSectionElement.querySelector('.trace-leading-title')?.remove();
      const metricsElement = buildTurnMetrics(firstResidentTurn);
      const head = buildTurnHead(firstResidentTurn, prepend.mergedHead, metricsElement);
      firstResidentSectionElement.insertBefore(head, firstResidentRowsElement);
      firstResidentSection.metricsElement = metricsElement;
    }
    if (!prepend.mergedHead) paintTurnMetrics(firstResidentTurn, firstResidentSection.metricsElement);
    const mergedRowsFragment = document.createDocumentFragment();
    for (const row of prepend.mergedRows) mergedRowsFragment.append(buildExpandableRow(row, firstResidentTurn.startedAt));
    firstResidentRowsElement.prepend(mergedRowsFragment);
    paintTurnRowOffsets(firstResidentRowsElement, firstResidentTurn);
  }
  const newTurnsFragment = document.createDocumentFragment();
  const newSections: TurnSection[] = [];
  for (const turn of prepend.newTurns) {
    const built = buildTurnSection(turn);
    newSections.push(built);
    newTurnsFragment.append(built.section);
  }
  turnsElement.prepend(newTurnsFragment);
  turnSections.unshift(...newSections);
}

function showPrependedRecords(prepend: TracePrepend): void {
  const canPrependInPlace = isTraceVisible() && !isRenderedTraceStale && !!turnsElement && !prepend.needsRerender;
  const scrollElement = rootElement?.parentElement ?? null;
  pendingPrependLayout = { canPrependInPlace, scrollElement, previousScrollHeight: scrollElement?.scrollHeight ?? 0, previousScrollTop: scrollElement?.scrollTop ?? 0 };
  if (canPrependInPlace) applyPrependToRenderedTurns(prepend);
}

function finishAfterTrim(trim: TraceTrim): void {
  applyTrimToRenderedTurns(trim);
  if (isRebuildDueAfterTrim) {
    isRebuildDueAfterTrim = false;
    renderPanel();
  }
  const layout = pendingPrependLayout;
  pendingPrependLayout = null;
  if (!layout) return;
  if (!layout.canPrependInPlace) renderPanel();
  if (layout.canPrependInPlace) renderHeader();
  if (layout.scrollElement) layout.scrollElement.scrollTop = layout.previousScrollTop + layout.scrollElement.scrollHeight - layout.previousScrollHeight;
}

function applyTraceChange(change: TraceChange): void {
  switch (change.kind) {
    case 'selection-reset':
      isRenderedTraceStale = true;
      return;
    case 'rebuild':
      renderPanel();
      return;
    case 'header':
      renderHeader();
      return;
    case 'sessions':
      if (change.hasSelectionChanged || !headerElement) renderPanel();
      if (!change.hasSelectionChanged && headerElement) renderHeader();
      return;
    case 'records-appended':
      showAppendedRecords(change.appends);
      return;
    case 'records-prepended':
      showPrependedRecords(change.prepend);
      return;
    case 'trimmed':
      finishAfterTrim(change.trim);
      return;
  }
}

function mountTraceView(parent: HTMLElement): void {
  if (rootElement) return;
  rootElement = el('div', 'trace-panel');
  parent.append(rootElement);
  setTraceLookingProbe(isTraceVisible);
  subscribeTrace(applyTraceChange);
  buildPanelContent();
}

function refreshTraceView(): void {
  if (!rootElement) return;
  const hasSelectionChanged = refreshTraceSelectionOnShow();
  if (!shouldRebuildTraceView({ hasSelectionChanged, isRenderedTraceStale, hasRenderedOnce: !!headerElement })) return;
  buildPanelContent();
}

export const view: ViewModule<HTMLElement> = { mount: mountTraceView, refresh: refreshTraceView };
