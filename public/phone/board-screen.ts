import { el, observeHeaderHeight } from '../dom-helpers.ts';
import type { SessionRowRefs } from '../session-row.ts';
import { buildSessionRow, paintSessionRow, wrapSessionRow } from '../session-row.ts';
import type { SessionRow } from '../focus-view/attention-core.ts';
import { countAttentionByKind, jumpTargetCount, orderAttentionQueue, orderRoster, pickNextAttention } from '../focus-view/attention-core.ts';
import { buildAttentionBanner, paintAttentionBanner, pressAttentionBanner } from '../attention-banner.ts';
import type { RosterGroup } from '../focus-view/roster-groups-core.ts';
import { groupRoster, visibleOrder } from '../focus-view/roster-groups-core.ts';
import type { SessionGroupHeader } from '../focus-view/roster-group-header.ts';
import { buildSessionGroupHeader, paintSessionGroupHeader } from '../focus-view/roster-group-header.ts';
import { showFirstRunChecklist } from '../onboarding/first-run-checklist.ts';
import { emptyProjectKeys, forgetProject } from '../project-registry.ts';
import { quickAddSession, readSessionRows, requestSessionRemoval } from '../session-actions.ts';
import type { ActivityRenderKind } from '../session-card/activity.ts';
import { pulseActivityGlyph } from '../session-card/activity.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { onSessionTick, sessionElapsedText } from '../session-card/session-tick.ts';

type BoardRow = SessionRow<SessionUi>;

const projectPathOf = (row: BoardRow) => row.ui.path;

interface GroupRefs extends SessionGroupHeader {
  rows: HTMLDivElement;
}

export function createBoardScreen({ onSelectSession }: { onSelectSession?: (id: string) => void }) {
  const screen = el('div', 'phone-board');

  const topBar = el('header', 'phone-topbar');

  let attentionCursorId: string | null = null;
  const nextAttentionButton = el('button', 'btn-dialog', 'Next');
  nextAttentionButton.type = 'button';
  nextAttentionButton.addEventListener('click', () => {
    pressAttentionBanner(attentionEl);
    const attentionIds = orderAttentionQueue(currentOrderedRows());
    const nextId = pickNextAttention(attentionIds, attentionCursorId);
    if (!nextId) return;
    attentionCursorId = nextId;
    onSelectSession?.(nextId);
  });
  const attentionEl = buildAttentionBanner(nextAttentionButton);

  const groupsEl = el('div', 'phone-board-list');

  const emptyEl = el('div', 'phone-empty');
  const emptyTitleEl = el('p', 'phone-empty-title', 'No sessions');
  const emptyDescEl = el('p', 'phone-empty-desc', 'Spawn a session to start watching.');
  emptyEl.append(emptyTitleEl, emptyDescEl);

  screen.append(topBar, attentionEl, groupsEl, emptyEl);

  const rowById = new Map<string, HTMLButtonElement>();
  const groupSectionByKey = new Map<string, HTMLElement>();
  const rowState = new WeakMap<HTMLButtonElement, { refs: SessionRowRefs; item: HTMLDivElement }>();
  const groupRefs = new WeakMap<HTMLElement, GroupRefs>();
  const orderKeys = new WeakMap<HTMLElement, string>();
  let attentionCount = 0;

  observeHeaderHeight(topBar);

  function buildRow(id: string) {
    const { row, refs } = buildSessionRow('button');
    row.type = 'button';
    row.dataset.id = id;
    row.addEventListener('click', () => onSelectSession?.(id));
    const { item } = wrapSessionRow(row, () => requestSessionRemoval(id));
    item.setAttribute('role', 'listitem');
    rowState.set(row, { refs, item });
    return row;
  }

  function buildGroup() {
    const section = el('section', 'phone-board-group');
    const groupHeader = buildSessionGroupHeader({
      onAdd: quickAddSession,
      onForget: (path) => {
        forgetProject(path);
        refresh();
      },
    });
    const rows = el('div', 'phone-board-group-rows');
    rows.setAttribute('role', 'list');
    section.append(groupHeader.header, rows);
    groupRefs.set(section, { ...groupHeader, rows });
    return section;
  }

  function paintRow(row: HTMLButtonElement, entry: BoardRow) {
    const rowDetails = rowState.get(row);
    if (!rowDetails) return;
    const { ui, state, name } = entry;
    paintSessionRow(row, rowDetails.refs, { ui, state, name, mergeStatus: ui.card?.dataset.merge || '' });
  }

  function paintGroup(section: HTMLElement, group: RosterGroup<BoardRow>) {
    const refs = groupRefs.get(section);
    if (!refs) return;
    paintSessionGroupHeader(refs, group, 'Board');
    refs.rows.setAttribute('aria-label', `${group.label} sessions`);
  }

  function currentOrderedRows() {
    return orderRoster(readSessionRows());
  }

  function refresh() {
    const orderedRows = currentOrderedRows();
    const boardGroups = groupRoster(orderedRows, projectPathOf, emptyProjectKeys(orderedRows, projectPathOf));
    const attentionCounts = countAttentionByKind(orderedRows);
    attentionCount = jumpTargetCount(attentionCounts);
    paintAttentionBanner(attentionEl, attentionCounts);

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
        paintRow(row, entry);
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
  }

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

  onSessionTick(() => {
    for (const [id, row] of rowById) {
      const ui = sessionUIs.get(id);
      const state = rowState.get(row);
      if (ui && state) state.refs.elapsed.textContent = sessionElapsedText(ui);
    }
  });

  return {
    el: screen,
    topBarEl: topBar,
    refresh,
    renderActivity,
    getAttentionCount: () => attentionCount,
  };
}
