import { borrowCard, getBorrowedCardId, releaseCard } from '../card-host.ts';
import { wireColumnResizer } from '../column-resizer.ts';
import { el } from '../dom-helpers.ts';
import { createLineIcon, IMAGE_ICON_PATH } from '../svg-dom.ts';
import { renderStatusLegend } from '../status-legend.ts';
import { showFirstRunChecklist } from '../onboarding/first-run-loader.ts';
import { emptyProjectKeys, forgetProject } from '../project-registry.ts';
import { getRestorableSessionId, quickAddSession, readSessionRows, requestSessionOpen, requestSessionRemoval, selectSession } from '../session-actions.ts';
import { markSessionSeen, showSessionPlanFace } from '../session-card/lifecycle.ts';
import type { ActivityRenderKind } from '../session-card/activity.ts';
import { addActivityRenderer, pulseActivityGlyph } from '../session-card/activity.ts';
import { buildNextAttentionKeys, SHORTCUT_PLATFORM } from '../shortcuts.ts';
import { railAriaKeyShortcuts } from '../shortcuts-core.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { sessionIdOf, sessionUIs } from '../session-card/card-registry.ts';
import { placeRowsInOrder, writeAttributeIfChanged, writeHiddenIfChanged, writeTextIfChanged } from '../status-paint.ts';
import { onLiveSessionTick, sessionElapsedText } from '../session-card/session-tick.ts';
import { setTerminalActiveViewer } from '../session-card/terminal.ts';
import { getRailWidth, setRailWidth } from '../ui-prefs.ts';
import { uiState } from '../ui-state-core.ts';
import type { AttentionTile, SessionRow } from './attention-core.ts';
import { countAttentionByKind, orderAttentionLine, orderRoster, pickAdjacent } from './attention-core.ts';
import type { RosterGroup } from './roster-groups-core.ts';
import { groupRoster, visibleOrder } from './roster-groups-core.ts';
import type { SessionGroupHeader } from './roster-group-header.ts';
import { buildSessionGroupHeader, paintSessionGroupHeader } from './roster-group-header.ts';
import { buildAttentionBanner, paintAttentionBanner, pressAttentionBanner, sendAttentionTileToRow, tetherAttentionTile } from '../attention-banner.ts';
import { buildSessionRow, paintSessionRow, wrapSessionRow } from '../session-row.ts';
import { unopenedShownCountOf } from '../shown-files.ts';

type RosterRow = SessionRow<SessionUi, string | null>;

const projectPathOf = (row: RosterRow) => row.ui.path;

type FocusPill = ReturnType<typeof buildPill>;

type GroupList = HTMLDivElement & { _lastOrderKey?: string };

const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

let railEl: HTMLElement | null = null;
let railHeadEl: HTMLElement | null = null;
let centerEl: HTMLElement | null = null;
let cardSlotEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;
let emptyTitleEl: HTMLElement | null = null;
let emptyDescEl: HTMLElement | null = null;

let active = false;
let isAttentionJumpActivating = false;
const mergeStatusById = new Map<string, string>();
const pillById = new Map<string, FocusPill>();

const groupListById = new Map<string, GroupList>();
const groupHeaderById = new Map<string, SessionGroupHeader>();

let railTabStopId: string | null = null;
let lastGroupOrderKey = '';
let lastRailOrder: string[] = [];

const NO_COLLAPSED = new Set<string>();
function railVisibleIds() { return visibleOrder(groupsOf(orderedSessions()), NO_COLLAPSED); }

function setRailTabStop(id: string | null) {
  const prev = railTabStopId;
  railTabStopId = id || null;
  if (prev && prev !== railTabStopId) {
    const p = pillById.get(prev);
    if (p) { p.tabIndex = -1; p.setAttribute('aria-selected', 'false'); }
  }
  if (railTabStopId) {
    const n = pillById.get(railTabStopId);
    if (n) { n.tabIndex = 0; n.setAttribute('aria-selected', 'true'); }
  }
}

function groupsOf(order: RosterRow[]) {
  return groupRoster(order, projectPathOf, emptyProjectKeys(order, projectPathOf));
}

function ensureGroup(group: RosterGroup<RosterRow>) {
  let groupHeader = groupHeaderById.get(group.key);
  let list = groupListById.get(group.key);
  if (!groupHeader || !list) {
    groupHeader = buildSessionGroupHeader({
      onAdd: quickAddSession,
      onForget: (path) => {
        forgetProject(path);
        refreshFocusRoster();
      },
    });
    list = el('div', 'focus-rail-list');
    list.setAttribute('role', 'listbox');
    groupHeaderById.set(group.key, groupHeader);
    groupListById.set(group.key, list);
  }
  paintSessionGroupHeader(groupHeader, group, 'rail');
  writeAttributeIfChanged(list, 'aria-label', `${group.label} sessions`);
  return { header: groupHeader.header, list };
}

export function isFocusActive() { return active; }

export function getFocusedSessionId() { return uiState.snapshot().focusedSessionId; }

export function mountFocusView({ rail, center, resizer }: { rail: HTMLElement | null; center: HTMLElement | null; resizer: HTMLElement | null }) {
  railEl = rail;
  centerEl = center;
  if (!railEl || !centerEl) return;
  const mountedRail = railEl;
  const mountedCenter = centerEl;
  wireRailResizer(resizer);

  mountedRail.removeAttribute('role');
  mountedRail.removeAttribute('aria-label');
  mountedRail.setAttribute('aria-keyshortcuts', railAriaKeyShortcuts(SHORTCUT_PLATFORM));

  railHeadEl = buildAttentionBanner({
    onJump: focusNextAttention,
    rowFor: (id) => pillById.get(id),
  }, buildNextAttentionKeys());

  const statusKey = el('details', 'rail-status-key');
  statusKey.append(el('summary', 'rail-status-key-summary', 'Status key'), renderStatusLegend());
  mountedRail.append(railHeadEl, statusKey);

  emptyEl = el('div', 'focus-empty');
  emptyEl.innerHTML = '<p class="focus-empty-title"></p>'
    + '<p class="focus-empty-desc"></p>';
  emptyTitleEl = emptyEl.querySelector<HTMLElement>('.focus-empty-title');
  emptyDescEl = emptyEl.querySelector<HTMLElement>('.focus-empty-desc');

  cardSlotEl = el('div', 'focus-card-slot');
  mountedCenter.append(emptyEl, cardSlotEl);

  mountedRail.addEventListener('keydown', onRailKeydown);
}

const RAIL_BOUNDS = { minPx: 180, maxPx: 480 };
const RAIL_KEY_STEP_PX = 16;

function wireRailResizer(resizer: HTMLElement | null) {
  if (!resizer || !railEl) return;
  wireColumnResizer({
    resizer,
    column: railEl,
    widthHost: railEl,
    widthProperty: '--rail-width',
    bounds: RAIL_BOUNDS,
    keyStepPx: RAIL_KEY_STEP_PX,
    getStoredWidth: getRailWidth,
    setStoredWidth: setRailWidth,
  });
}

function onRailKeydown(e: KeyboardEvent) {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const target = e.target instanceof HTMLElement ? e.target : null;
    const id = target?.dataset.id;
    if (!id || pillById.get(id) !== target) return;
    e.preventDefault();
    requestSessionRemoval(id);
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;

  const id = pickAdjacent(railVisibleIds(), railTabStopId, e.key === 'ArrowDown' ? 1 : -1);
  if (id == null) return;
  e.preventDefault();
  setRailTabStop(id);
  pillById.get(id)?.focus();
}

function orderedSessions() {
  return orderRoster(readSessionRows(sessionName));
}

function sessionName(ui: SessionUi): string | null {
  return ui.nameEl ? ui.nameEl.textContent : (ui.card ? (ui.card.dataset.session || ui.card.dataset.id || '') : '');
}

function buildPill(id: string) {
  const { row: button, refs } = buildSessionRow('button');
  button.type = 'button';
  button.dataset.id = id;
  button.setAttribute('role', 'option');
  button.addEventListener('click', () => onPillActivate(id));
  button.addEventListener('pointerenter', () => { if (railHeadEl) tetherAttentionTile(railHeadEl, id); });
  button.addEventListener('pointerleave', () => { if (railHeadEl) tetherAttentionTile(railHeadEl, null); });

  const { item, removeButton } = wrapSessionRow(button, () => requestSessionRemoval(id));
  item.setAttribute('role', 'presentation');
  removeButton.tabIndex = -1;
  const shownCount = el('span', 'session-row-shown');
  shownCount.hidden = true;
  shownCount.append(createLineIcon(IMAGE_ICON_PATH), el('span', 'session-row-shown-count'));
  refs.name.after(shownCount);
  return Object.assign(button, { _refs: refs, _row: item, _shownCount: shownCount });
}

function onPillActivate(id: string) {
  const ui = requestSessionOpen(id);
  if (!ui) return;
  focusSession(id);
  focusTerminalAfterSettle(ui, id);
}

function paintPillShownCount(shownCount: HTMLElement, unopenedCount: number) {
  writeHiddenIfChanged(shownCount, unopenedCount === 0);
  writeAttributeIfChanged(shownCount, 'title', `${unopenedCount} shown ${unopenedCount === 1 ? 'file' : 'files'} not opened`);
  const countText = shownCount.querySelector<HTMLElement>('.session-row-shown-count');
  if (countText) writeTextIfChanged(countText, String(unopenedCount));
}

function paintPill(pill: FocusPill, { id, ui, state, name }: RosterRow, attentionPosition: number | null) {
  const mergeStatus = mergeStatusById.get(id) || 'none';
  pill.classList.toggle('focused', id === getFocusedSessionId());
  paintSessionRow(pill, pill._refs, { ui, state, name: name ?? '', mergeStatus: mergeStatus === 'none' ? '' : mergeStatus, attentionPosition });
  paintPillShownCount(pill._shownCount, unopenedShownCountOf(id));
  const isTabStop = id === railTabStopId;
  writeAttributeIfChanged(pill, 'aria-selected', String(isTabStop));
  writeAttributeIfChanged(pill, 'tabindex', isTabStop ? '0' : '-1');
}

function renderPillActivity(ui: SessionUi, kind: ActivityRenderKind) {
  if (!active) return;
  const id = ui?.card?.dataset.id;
  const pill = id ? pillById.get(id) : null;
  if (!pill) return;
  if (kind === 'flag') {
    pill.dataset.activity = ui._activity || '';
    return;
  }
  pulseActivityGlyph(pill._refs?.glyph);
}
addActivityRenderer(renderPillActivity);

onLiveSessionTick((id, ui) => {
  if (!active) return;
  const pill = pillById.get(id);
  if (pill) writeTextIfChanged(pill._refs.elapsed, sessionElapsedText(ui));
});

const paintedAttentionPositionById = new Map<string, number | null>();

export function refreshFocusRoster(dirtySessionIds?: ReadonlySet<string>) {
  if (!active) return;
  const mountedRail = railEl;
  if (!mountedRail) return;
  const order = orderedSessions();
  const groups = groupsOf(order);
  const seen = new Set<string>();
  const attentionTiles = orderAttentionLine(order, getFocusedSessionId());
  const attentionPositionById = new Map(attentionTiles.map(({ id }, index) => [id, index + 1]));

  const placeList = (rows: RosterRow[], listEl: GroupList) => {
    const newKey = rows.map((r) => r.id).join(',');
    const orderUnchanged = listEl._lastOrderKey === newKey && listEl.childElementCount === rows.length;
    for (const row of rows) {
      const { id } = row;
      seen.add(id);
      let pill = pillById.get(id);
      const isNewPill = !pill;
      if (!pill) { pill = buildPill(id); pillById.set(id, pill); }
      const attentionPosition = attentionPositionById.get(id) ?? null;
      const isPaintNeeded = !dirtySessionIds || isNewPill || dirtySessionIds.has(id) || paintedAttentionPositionById.get(id) !== attentionPosition;
      if (isPaintNeeded) paintPill(pill, row, attentionPosition);
      paintedAttentionPositionById.set(id, attentionPosition);
    }
    if (!orderUnchanged) placeRowsInOrder(listEl, rows.flatMap(({ id }) => pillById.get(id)?._row ?? []));
    listEl._lastOrderKey = newKey;
  };

  const presentKeys = new Set(groups.order);
  const groupOrderKey = groups.groups.map((group) => group.key).join('\n');
  const groupsAlreadyInPlace = groupOrderKey === lastGroupOrderKey;
  lastGroupOrderKey = groupOrderKey;
  for (const group of groups.groups) {
    const { header, list } = ensureGroup(group);
    if (!groupsAlreadyInPlace) mountedRail.append(header, list);
    placeList(group.rows, list);
  }

  for (const [key, groupHeader] of [...groupHeaderById]) {
    if (!presentKeys.has(key)) {
      groupHeader.header.remove();
      groupListById.get(key)?.remove();
      groupHeaderById.delete(key);
      groupListById.delete(key);
    }
  }

  for (const [id, pill] of pillById) {
    if (!seen.has(id)) {
      pill._row.remove();
      pillById.delete(id);
      paintedAttentionPositionById.delete(id);
      if (id === railTabStopId) railTabStopId = null;
    }
  }

  for (const id of [...mergeStatusById.keys()]) {
    if (!sessionUIs.has(id)) mergeStatusById.delete(id);
  }

  const previousRailOrder = lastRailOrder;
  lastRailOrder = visibleOrder(groups, NO_COLLAPSED);

  const staleFocusedId = getFocusedSessionId();
  if (staleFocusedId && !sessionUIs.has(staleFocusedId)) {
    uiState.dispatch('focusSession', null);
    railTabStopId = null;
    const neighborId = pickNeighborOfRemoved(previousRailOrder, staleFocusedId);
    if (neighborId) {
      const wasTerminalFocusLost = !document.activeElement || document.activeElement === document.body;
      focusSession(neighborId);
      if (wasTerminalFocusLost) focusTerminalAfterSettle(sessionUIs.get(neighborId), neighborId);
      return;
    }
  }

  updateCenter();
  const centeredId = getFocusedSessionId();
  if (centeredId) {
    const ui = sessionUIs.get(centeredId);
    if (ui && ui.card.parentElement !== cardSlotEl) borrowToCenter(ui, centeredId);
  }
  updateRailHead(order, attentionTiles);
}

function pickNeighborOfRemoved(previousRailOrder: readonly string[], removedId: string) {
  const survivorsAndRemoved = previousRailOrder.filter((id) => id === removedId || sessionUIs.has(id));
  if (survivorsAndRemoved.length < 2) return lastRailOrder.find((id) => sessionUIs.has(id)) ?? null;
  const isRemovedLast = survivorsAndRemoved.indexOf(removedId) === survivorsAndRemoved.length - 1;
  return pickAdjacent(survivorsAndRemoved, removedId, isRemovedLast ? -1 : 1);
}

function attentionLine() {
  return orderAttentionLine(orderedSessions(), getFocusedSessionId());
}

function updateRailHead(rosterOrderedRows: readonly RosterRow[], attentionTiles: readonly AttentionTile[]) {
  if (!railHeadEl) return;
  paintAttentionBanner(railHeadEl, countAttentionByKind(rosterOrderedRows), attentionTiles);
}

export function focusNextAttention() {
  if (!active) return;
  if (railHeadEl) pressAttentionBanner(railHeadEl);
  const nextId = attentionLine()[0]?.id;
  if (nextId) openAttentionSession(nextId);
}

function openAttentionSession(id: string) {
  if (!active) return;
  pillById.get(id)?.scrollIntoView({ block: 'nearest' });
  if (railHeadEl) sendAttentionTileToRow(railHeadEl, id, () => flashAttention(id));
  const ui = sessionUIs.get(id);
  requestSessionOpen(id);
  focusSession(id);
  focusTerminalAfterSettle(ui, id);
}

function focusTerminalAfterSettle(ui: SessionUi | null | undefined, id: string) {
  if (!ui) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (active && getFocusedSessionId() === id) ui.term?.focus();
  }));
}

function flashAttention(id: string) {
  if (reducedMotion?.matches || document.hidden) return;
  const pill = pillById.get(id);
  if (pill?.animate) {
    pill.animate(
      [
        { transform: 'scale(1)' },
        { transform: 'scale(1.045)', offset: 0.3 },
        { transform: 'scale(1)' },
      ],
      { duration: 360, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
    pill._row.animate(
      [{ boxShadow: '0 0 0 3px var(--accent)' }, { boxShadow: '0 0 0 3px transparent' }],
      { duration: 700, easing: 'ease-out' },
    );
  }
  const card = sessionUIs.get(id)?.card;
  if (card?.animate) {
    card.animate([{ opacity: 0.8 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
  }
}

function borrowToCenter(ui: SessionUi, id: string) {
  if (!cardSlotEl) return;
  borrowCard(ui, id, cardSlotEl, { className: 'focus-centered' });
  setTerminalActiveViewer(ui, id, true);
}

function releaseCenter() {
  const centeredId = getFocusedSessionId();
  if (!centeredId) return;
  if (getBorrowedCardId() === centeredId) releaseCard();
  uiState.dispatch('focusSession', null);
}

function focusSession(id: string) {
  if (!active || !sessionUIs.has(id)) return;
  markSessionSeen(id);
  selectSession(id);
  if (id === getFocusedSessionId()) return;
  releaseCenter();
  uiState.dispatch('focusSession', id);
  railTabStopId = id;
  refreshFocusRoster();
}

function updateCenter() {
  if (!emptyEl || !emptyTitleEl || !emptyDescEl) return;
  const centeredId = getFocusedSessionId();
  const has = !!(centeredId && sessionUIs.has(centeredId));
  const hasSessions = sessionUIs.size > 0;
  writeHiddenIfChanged(emptyEl, has);
  showFirstRunChecklist(emptyEl, !hasSessions);
  writeHiddenIfChanged(emptyTitleEl, !hasSessions);
  writeHiddenIfChanged(emptyDescEl, !hasSessions);
  if (has || !hasSessions) return;

  writeTextIfChanged(emptyTitleEl, 'No session selected');
  writeTextIfChanged(emptyDescEl, 'Select a session from the rail on the left to focus it here.');
}

export function setFocusMergeStatus(id: unknown, mergeStatus: unknown) {
  mergeStatusById.set(sessionIdOf(id), typeof mergeStatus === 'string' && mergeStatus ? mergeStatus : 'none');
  if (active) refreshFocusRoster();
}

export function centerSessionQuietly(id: string) {
  if (!active || !sessionUIs.has(id)) return;
  focusSession(id);
}

export function openPlanInFocus(id: string) {
  if (!active || !sessionUIs.has(id)) return false;
  focusSession(id);
  return showSessionPlanFace(id);
}

export function focusNthInRail(n: number) {
  if (!active) return;
  const id = railVisibleIds()[n - 1];
  if (id) onPillActivate(id);
}

export function focusAdjacentInRail(dir: number) {
  if (!active) return;
  const id = pickAdjacent(railVisibleIds(), railTabStopId, dir);
  if (id == null) return;
  onPillActivate(id);
  pillById.get(id)?.scrollIntoView({ block: 'nearest' });
}

window.addEventListener('focus', () => {
  const centeredId = getFocusedSessionId();
  if (active && centeredId) markSessionSeen(centeredId);
});

export function activateFocusView() {
  if (!railEl) return;
  active = true;

  releaseCenter();
  railTabStopId = null;
  refreshFocusRoster();
  if (isAttentionJumpActivating && attentionLine().length > 0) {
    focusNextAttention();
    return;
  }
  if (isAttentionJumpActivating && railHeadEl) pressAttentionBanner(railHeadEl);
  restoreFocusedSession();
}

export function activateFocusOnNextAttention(activateFocus: () => void) {
  isAttentionJumpActivating = true;
  try {
    activateFocus();
  } finally {
    isAttentionJumpActivating = false;
  }
}

export function restoreFocusedSession() {
  if (!active || getFocusedSessionId()) return;
  const id = getRestorableSessionId();
  if (!id) return;
  focusSession(id);
}

export function deactivateFocusView() {
  if (!active) return;
  releaseCenter();
  railTabStopId = null;
  active = false;
}
