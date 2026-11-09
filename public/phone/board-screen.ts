import { el, observeHeaderHeight } from '../dom-helpers.ts';
import type { SessionRowRefs } from '../session-row.ts';
import { buildSessionRow, paintSessionRow, wrapSessionRow } from '../session-row.ts';
import type { SessionRow } from '../focus-view/attention-core.ts';
import { countAttentionByKind, orderAttentionLine, orderRoster, sessionOrderOf } from '../focus-view/attention-core.ts';
import { settingsPayloadSnapshot, subscribeSettings } from '../settings/settings-store.ts';
import { wireBoardRowReorder } from './board-row-reorder.ts';
import { buildAttentionBanner, buildAttentionLedger, paintAttentionBanner, paintAttentionLedger, pressAttentionBanner, sendAttentionTileToRow } from '../attention-banner.ts';
import type { RosterGroup } from '../focus-view/roster-groups-core.ts';
import { groupRoster, visibleOrder } from '../focus-view/roster-groups-core.ts';
import { raceGroupOf } from '../arena/race-store.ts';
import type { SessionGroupHeader } from '../focus-view/roster-group-header.ts';
import { buildSessionGroupHeader, paintSessionGroupHeader } from '../focus-view/roster-group-header.ts';
import { showFirstRunChecklist } from '../onboarding/first-run-loader.ts';
import { quickAddSession, readSessionRows, requestSessionRemoval, undoPendingClose } from '../session-actions.ts';
import type { ActivityRenderKind } from '../session-card/activity.ts';
import { pulseActivityGlyph } from '../session-card/activity.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { writeTextIfChanged } from '../status-paint.ts';
import { onLiveSessionTick, sessionElapsedText } from '../session-card/session-tick.ts';
import { hostGroupOf } from '../hosts/session-hosts.ts';

type BoardRow = SessionRow<SessionUi>;

const projectPathOf = (row: BoardRow) => row.ui.path;
const hostOfRow = (row: BoardRow) => hostGroupOf(row.id);

interface GroupRefs extends SessionGroupHeader {
  rows: HTMLDivElement;
}

export function createBoardScreen({ onSelectSession, shownSessionId }: { onSelectSession?: (id: string) => void; shownSessionId?: () => string | null }) {
  const screen = el('div', 'phone-board');

  const topBar = el('header', 'phone-topbar');

  const attentionEl = buildAttentionBanner({
    onJump: () => {
      pressAttentionBanner(attentionEl);
      const nextId = orderAttentionLine(currentOrderedRows(), null)[0]?.id;
      if (nextId) openAttentionSession(nextId);
    },
    rowFor: (id) => rowById.get(id),
  });

  const ledgerEl = buildAttentionLedger((id) => selectSession(id));

  let pendingLandingId: string | null = null;

  function openAttentionSession(id: string) {
    pendingLandingId = id;
    rowById.get(id)?.scrollIntoView({ block: 'nearest' });
    sendAttentionTileToRow(attentionEl, id, () => {
      if (pendingLandingId !== id) return;
      selectSession(id);
    });
  }

  function selectSession(id: string) {
    pendingLandingId = null;
    onSelectSession?.(id);
  }

  const groupsEl = el('div', 'phone-board-list');

  const emptyEl = el('div', 'phone-empty');
  const emptyTitleEl = el('p', 'phone-empty-title', 'No sessions');
  const emptyDescEl = el('p', 'phone-empty-desc', 'Spawn a session to start watching.');
  emptyEl.append(emptyTitleEl, emptyDescEl);

  screen.append(topBar, groupsEl, emptyEl, ledgerEl, attentionEl);

  const rowById = new Map<string, HTMLButtonElement>();
  const groupSectionByKey = new Map<string, HTMLElement>();
  const rowState = new WeakMap<HTMLButtonElement, { refs: SessionRowRefs; item: HTMLDivElement }>();
  const groupRefs = new WeakMap<HTMLElement, GroupRefs>();
  const orderKeys = new WeakMap<HTMLElement, string>();
  const groupKeyBySessionId = new Map<string, string>();
  let boardRowsInOrder: BoardRow[] = [];

  observeHeaderHeight(topBar);

  function buildRow(id: string) {
    const { row, refs } = buildSessionRow();
    row.dataset.id = id;
    row.addEventListener('click', () => selectSession(id));
    const { item } = wrapSessionRow(row, () => requestSessionRemoval(id), () => undoPendingClose(id));
    item.setAttribute('role', 'listitem');
    rowState.set(row, { refs, item });
    return row;
  }

  function buildGroup() {
    const section = el('section', 'phone-board-group');
    const groupHeader = buildSessionGroupHeader({
      onAdd: quickAddSession,
    });
    const rows = el('div', 'phone-board-group-rows');
    rows.setAttribute('role', 'list');
    section.append(groupHeader.header, rows);
    groupRefs.set(section, { ...groupHeader, rows });
    return section;
  }

  function paintRow(row: HTMLButtonElement, entry: BoardRow, attentionPosition: number | null) {
    const rowDetails = rowState.get(row);
    if (!rowDetails) return;
    const { ui, state, name } = entry;
    row.classList.toggle('focused', entry.id === shownSessionId?.());
    paintSessionRow(row, rowDetails.refs, { ui, state, name, mergeStatus: ui.card?.dataset.merge || '', attentionPosition });
  }

  function paintGroup(section: HTMLElement, group: RosterGroup<BoardRow>) {
    const refs = groupRefs.get(section);
    if (!refs) return;
    paintSessionGroupHeader(refs, group, { isHostShown: true });
    refs.rows.setAttribute('aria-label', `${group.label} sessions`);
  }

  function currentOrderedRows() {
    return orderRoster(readSessionRows(), sessionOrderOf(settingsPayloadSnapshot()));
  }

  function refresh() {
    const orderedRows = currentOrderedRows();
    const boardGroups = groupRoster(orderedRows, projectPathOf, raceGroupOf, hostOfRow);
    boardRowsInOrder = boardGroups.groups.flatMap((group) => group.rows);
    groupKeyBySessionId.clear();
    for (const group of boardGroups.groups) for (const entry of group.rows) groupKeyBySessionId.set(entry.id, group.key);
    const attentionCounts = countAttentionByKind(orderedRows);
    const attentionLine = orderAttentionLine(orderedRows, null);
    const attentionPositionById = new Map(attentionLine.map(({ id }, index) => [id, index + 1]));
    paintAttentionBanner(attentionEl, attentionCounts, attentionLine);
    paintAttentionLedger(ledgerEl, orderedRows);

    const presentGroupKeys = new Set(boardGroups.order);
    const groupOrderKey = boardGroups.order.join(',');
    const groupOrderUnchanged = orderKeys.get(groupsEl) === groupOrderKey
      && groupsEl.childElementCount === boardGroups.groups.length;
    for (const group of boardGroups.groups) {
      let section = groupSectionByKey.get(group.key);
      if (!section) {
        section = buildGroup();
        groupSectionByKey.set(group.key, section);
      }
      paintGroup(section, group);
      if (!groupOrderUnchanged) groupsEl.appendChild(section);
      const rowOrderKey = group.rows.map((entry) => entry.id).join(',');
      const refs = groupRefs.get(section);
      if (!refs) continue;
      const rowOrderUnchanged = orderKeys.get(refs.rows) === rowOrderKey
        && refs.rows.childElementCount === group.rows.length;
      for (const entry of group.rows) {
        let row = rowById.get(entry.id);
        if (!row) {
          row = buildRow(entry.id);
          rowById.set(entry.id, row);
        }
        paintRow(row, entry, attentionPositionById.get(entry.id) ?? null);
        const state = rowState.get(row);
        if (!state) continue;
        if (!rowOrderUnchanged) refs.rows.appendChild(state.item);
      }
      orderKeys.set(refs.rows, rowOrderKey);
    }
    orderKeys.set(groupsEl, groupOrderKey);
    for (const [key, section] of [...groupSectionByKey]) {
      if (presentGroupKeys.has(key)) continue;
      section.remove();
      groupSectionByKey.delete(key);
    }
    const seen = new Set(visibleOrder(boardGroups));
    for (const [id, row] of [...rowById]) {
      if (seen.has(id)) continue;
      const state = rowState.get(row);
      if (state) state.item.remove();
      rowById.delete(id);
    }

    const hasGroups = boardGroups.groups.length > 0;
    const isFirstRun = sessionUIs.size === 0;
    groupsEl.hidden = !hasGroups;
    emptyEl.hidden = hasGroups;
    showFirstRunChecklist(emptyEl, isFirstRun);
    emptyTitleEl.hidden = isFirstRun;
    emptyDescEl.hidden = isFirstRun;
    attentionEl.hidden = isFirstRun;
  }

  wireBoardRowReorder(groupsEl, {
    rowsInBoardOrder: () => boardRowsInOrder,
    groupKeyOf: (row) => groupKeyBySessionId.get(row.id) ?? '',
    itemFor: (sessionId) => {
      const row = rowById.get(sessionId);
      return row ? rowState.get(row)?.item : undefined;
    },
    repaint: refresh,
  });

  function renderActivity(ui: SessionUi, kind: ActivityRenderKind) {
    const id = ui.card?.dataset.id;
    const row = id ? rowById.get(id) : undefined;
    if (!row) return;
    if (kind === 'flag') {
      row.dataset.activity = ui._activity || '';
      return;
    }
    pulseActivityGlyph(rowState.get(row)?.refs.glyph);
  }

  onLiveSessionTick((id, ui) => {
    const row = rowById.get(id);
    const state = row ? rowState.get(row) : undefined;
    if (state) writeTextIfChanged(state.refs.elapsed, sessionElapsedText(ui));
  });

  subscribeSettings((change) => {
    if (change.kind === 'broadcast' && screen.isConnected) refresh();
  });

  return {
    el: screen,
    topBarEl: topBar,
    refresh,
    renderActivity,
  };
}
