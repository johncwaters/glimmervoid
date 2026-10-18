import { createUnseenCompleteTracker } from '../focus-view/unseen-complete-core.ts';
import { el, observeHeaderHeight } from '../dom-helpers.ts';
import type { SessionRowRefs } from '../session-row.ts';
import { buildSessionRow, paintSessionRow, wrapSessionRow } from '../session-row.ts';
import type { SessionRow } from '../focus-view/attention-core.ts';
import { attentionSummaryText, countAttentionByKind, orderRoster } from '../focus-view/attention-core.ts';
import type { RosterGroup } from '../focus-view/roster-groups-core.ts';
import { NO_PATH_KEY } from '../focus-view/roster-groups-core.ts';
import { showFirstRunChecklist } from '../onboarding/first-run-checklist.ts';
import { paintProjectHeaderCoherence } from '../project-header.ts';
import { emptyProjectKeys, forgetProject } from '../project-registry.ts';
import { readSessionRows, requestSessionRemoval } from '../session-actions.ts';
import { attachProjectActionsMenu } from '../project-actions-menu.ts';
import type { ActivityRenderKind } from '../session-card/activity.ts';
import { pulseActivityGlyph } from '../session-card/activity.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { onSessionTick, sessionElapsedText } from '../session-card/session-tick.ts';
import { groupSessionsForBoard } from './board-groups-core.ts';

type BoardRow = SessionRow<SessionUi>;

const projectPathOf = (row: BoardRow) => row.ui.path;

interface GroupRefs {
  header: HTMLDivElement;
  label: HTMLSpanElement;
  count: HTMLSpanElement;
  addButton: HTMLButtonElement;
  forgetButton: HTMLButtonElement;
  rows: HTMLDivElement;
}

export function createBoardScreen({ onSelectSession }: { onSelectSession?: (id: string) => void }) {
  const screen = el('div', 'phone-board');

  const topBar = el('header', 'phone-topbar');

  const attentionEl = el('div', 'phone-attention');
  attentionEl.setAttribute('role', 'status');
  attentionEl.setAttribute('aria-live', 'polite');

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

  function buildGroup(key: string) {
    const section = el('section', 'phone-board-group');
    section.dataset.key = key;
    const header = el('div', 'phone-board-group-header');
    const label = el('span', 'phone-board-group-label');
    const count = el('span', 'phone-board-group-count');
    const addButton = el('button', 'phone-board-group-add', '+');
    addButton.type = 'button';
    const actionsMenu = attachProjectActionsMenu(addButton, () => ({ path: section.dataset.path ?? '', label: section.dataset.label ?? '' }));
    const forgetButton = el('button', 'phone-board-group-forget', 'x');
    forgetButton.type = 'button';
    forgetButton.addEventListener('click', () => {
      forgetProject(section.dataset.path);
      refresh();
    });
    const rows = el('div', 'phone-board-group-rows');
    rows.setAttribute('role', 'list');
    header.append(label, count, forgetButton, addButton, actionsMenu);
    section.append(header, rows);
    groupRefs.set(section, { header, label, count, addButton, forgetButton, rows });
    return section;
  }

  function paintRow(row: HTMLButtonElement, entry: BoardRow) {
    const rowDetails = rowState.get(row);
    if (!rowDetails) return;
    const { ui, state, unseen, name } = entry;
    paintSessionRow(row, rowDetails.refs, { ui, state, name, unseen, mergeStatus: ui.card?.dataset.merge || '' });
  }

  function paintGroup(section: HTMLElement, group: RosterGroup<BoardRow>) {
    const refs = groupRefs.get(section);
    if (!refs) return;
    const { header, label, count, addButton, forgetButton, rows } = refs;
    const isPathless = group.key === NO_PATH_KEY;
    const isEmpty = group.rows.length === 0;
    section.dataset.path = group.key;
    section.dataset.label = group.label;
    section.toggleAttribute('data-empty', isEmpty);
    header.title = group.title;
    label.textContent = group.label;
    count.textContent = String(group.rows.length);
    count.title = `${group.rows.length} ${group.rows.length === 1 ? 'session' : 'sessions'}`;
    addButton.hidden = isPathless;
    forgetButton.hidden = isPathless || !isEmpty;
    if (!isPathless) {
      addButton.title = `${group.label} actions`;
      addButton.setAttribute('aria-label', `${group.label} actions`);
    }
    if (!isPathless && isEmpty) {
      forgetButton.title = `Remove ${group.label} from the Board`;
      forgetButton.setAttribute('aria-label', `Remove ${group.label} from the Board`);
    }
    paintProjectHeaderCoherence(header, group.key);
    rows.setAttribute('aria-label', `${group.label} sessions`);
  }

  const { noteStates, acknowledge, isUnseen } = createUnseenCompleteTracker();

  function currentOrderedRows() {
    const entries = readSessionRows();
    noteStates(entries);
    for (const entry of entries) entry.unseen = isUnseen(entry.id);
    return orderRoster(entries);
  }

  function refresh() {
    const orderedRows = currentOrderedRows();
    const boardGroups = groupSessionsForBoard(
      orderedRows,
      projectPathOf,
      emptyProjectKeys(orderedRows, projectPathOf),
    );
    const attentionCounts = countAttentionByKind(orderedRows);
    attentionCount = attentionCounts.waitingCount + attentionCounts.finishedCount;
    attentionEl.textContent = attentionSummaryText(attentionCounts);
    attentionEl.toggleAttribute('data-lit', attentionCount > 0);

    const presentGroupKeys = new Set(boardGroups.order);
    const groupOrderKey = boardGroups.order.join(',');
    const groupOrderUnchanged = orderKeys.get(groupsEl) === groupOrderKey
      && groupsEl.childElementCount === boardGroups.groups.length;
    for (const group of boardGroups.groups) {
      let section = groupSectionByKey.get(group.key);
      if (!section) {
        section = buildGroup(group.key);
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
    const seen = new Set(boardGroups.visibleIds);
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
    acknowledge,
    renderActivity,
    getAttentionCount: () => attentionCount,
  };
}
