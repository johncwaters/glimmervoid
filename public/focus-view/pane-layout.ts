import type { FocusLayout, PaneTab } from '#shared/contracts/focus-layout.ts';
import { el } from '../dom-helpers.ts';
import { createPressable } from '../ui/pressable.ts';
import { getFocusLayout, setFocusLayout } from '../ui-prefs.ts';
import type { VisibleLayout } from './pane-layout-core.ts';
import { activateTab, dropZoneAt, groupsOf, moveTab, resizeSplit, trailGroupIndex, visibleLayout } from './pane-layout-core.ts';

const TAB_LABELS: Record<PaneTab, string> = { terminal: 'Terminal', board: 'Board' };
const PANE_TABS: readonly PaneTab[] = ['terminal', 'board'];
const DIVIDER_KEY_STEP = 0.05;
const DRAG_MIME = 'application/x-glimmervoid-pane-tab';

interface StripHost {
  parent: HTMLElement;
  before: Element | null;
}

interface GroupParts {
  group: HTMLElement;
  strip: HTMLElement;
  tabList: HTMLElement;
  tail: HTMLElement;
  body: HTMLElement;
}

export interface PaneLayout {
  element: HTMLElement;
  trailSlot: HTMLElement;
  bodyOf: (tab: PaneTab) => HTMLElement;
  setTabTools: (tab: PaneTab, tools: HTMLElement | null) => void;
  setTabTitle: (tab: PaneTab, readTitle: () => string) => void;
  setStripHost: (tab: PaneTab, host: StripHost | null) => void;
  showTabs: (shownTabs: ReadonlySet<PaneTab>, options?: { holdSplit?: boolean }) => void;
  showTab: (tab: PaneTab) => void;
}

export function createPaneLayout(): PaneLayout {
  let layout: FocusLayout = getFocusLayout();
  let shownTabs: ReadonlySet<PaneTab> = new Set<PaneTab>(['terminal']);
  let shown: VisibleLayout = visibleLayout(layout, shownTabs);
  let draggedTab: PaneTab | null = null;
  let isSplitHeld = false;

  const element = el('div', 'pane-layout');
  const trailSlot = el('div', 'pane-trail');
  const divider = el('div', 'pane-divider');
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-label', 'Resize panes');
  divider.tabIndex = 0;

  const bodyByTab: Record<PaneTab, HTMLElement> = { terminal: buildBody('terminal'), board: buildBody('board') };
  const tabButtonByTab: Record<PaneTab, HTMLButtonElement> = { terminal: buildTabButton('terminal'), board: buildTabButton('board') };
  const toolsByTab = new Map<PaneTab, HTMLElement>();
  const titleReaderByTab = new Map<PaneTab, () => string>();
  const stripHostByTab = new Map<PaneTab, StripHost>();
  const groupParts: GroupParts[] = [buildGroup(0), buildGroup(1)];

  function buildBody(tab: PaneTab): HTMLElement {
    const body = el('div', 'pane-body');
    body.id = `focus-pane-${tab}`;
    body.dataset.pane = tab;
    body.setAttribute('role', 'tabpanel');
    return body;
  }

  function buildTabButton(tab: PaneTab): HTMLButtonElement {
    const button = createPressable('pane-tab', TAB_LABELS[tab]);
    button.draggable = true;
    button.dataset.tab = tab;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `focus-pane-${tab}`);
    button.addEventListener('click', () => onTabClick(tab));
    const refreshTitle = () => {
      button.title = titleReaderByTab.get(tab)?.() ?? '';
    };
    button.addEventListener('pointerenter', refreshTitle);
    button.addEventListener('focus', refreshTitle);
    button.addEventListener('dragstart', (event) => {
      draggedTab = tab;
      event.dataTransfer?.setData(DRAG_MIME, tab);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      element.dataset.dragging = '';
    });
    button.addEventListener('dragend', endDrag);
    return button;
  }

  function buildGroup(visibleIndex: number): GroupParts {
    const group = el('section', 'pane-group');
    const strip = el('div', 'pane-strip');
    const tabList = el('div', 'pane-tabs');
    tabList.setAttribute('role', 'tablist');
    const tail = el('div', 'pane-strip-tail');
    strip.append(tabList, tail);
    const body = el('div', 'pane-group-body');
    group.append(strip, body);
    group.addEventListener('dragover', (event) => {
      if (!draggedTab) return;
      event.preventDefault();
      group.dataset.dropZone = dropZoneOver(group, strip, event);
    });
    group.addEventListener('dragleave', (event) => {
      if (event.relatedTarget instanceof Node && group.contains(event.relatedTarget)) return;
      delete group.dataset.dropZone;
    });
    group.addEventListener('drop', (event) => {
      if (!draggedTab) return;
      event.preventDefault();
      const zone = dropZoneOver(group, strip, event);
      const targetGroupIndex = shown.groupIndexes[visibleIndex];
      const movedTab = draggedTab;
      endDrag();
      if (targetGroupIndex === undefined) return;
      commit(moveTab(layout, movedTab, targetGroupIndex, zone));
    });
    return { group, strip, tabList, tail, body };
  }

  function dropZoneOver(group: HTMLElement, strip: HTMLElement, event: DragEvent) {
    if (event.target instanceof Node && strip.contains(event.target)) return 'join';
    const rect = group.getBoundingClientRect();
    return dropZoneAt(event.clientX - rect.left, event.clientY - rect.top, rect);
  }

  function endDrag() {
    draggedTab = null;
    delete element.dataset.dragging;
    for (const { group } of groupParts) delete group.dataset.dropZone;
  }

  function onTabClick(tab: PaneTab) {
    if (isSplitHeld && tab === 'terminal') return;
    releaseHeldSplitAndCommit(activateTab(layout, tab));
  }

  function releaseHeldSplitAndCommit(next: FocusLayout) {
    if (!isSplitHeld) {
      commit(next);
      return;
    }
    isSplitHeld = false;
    if (next !== layout) {
      commit(next);
      return;
    }
    render();
  }

  function heldLayoutOf(storedLayout: FocusLayout): FocusLayout {
    const terminalGroupIndex = groupsOf(storedLayout).findIndex((group) => group.tabs.includes('terminal'));
    return activateTab(moveTab(storedLayout, 'board', terminalGroupIndex, 'join'), 'terminal');
  }

  function commit(next: FocusLayout) {
    if (next === layout) return;
    layout = next;
    setFocusLayout(layout);
    render();
  }

  function placeChild(parent: HTMLElement, child: HTMLElement) {
    if (child.parentElement !== parent) parent.append(child);
  }

  function replaceChildrenIfChanged(parent: HTMLElement, children: HTMLElement[]) {
    const isUnchanged = parent.children.length === children.length && children.every((child, index) => parent.children[index] === child);
    if (!isUnchanged) parent.replaceChildren(...children);
  }

  function placeStrip(parts: GroupParts, host: StripHost | undefined) {
    if (!host) {
      if (parts.group.firstElementChild !== parts.strip) parts.group.prepend(parts.strip);
      return;
    }
    const isPlaced = parts.strip.parentElement === host.parent && (host.before === null || parts.strip.nextElementSibling === host.before);
    if (!isPlaced) host.parent.insertBefore(parts.strip, host.before);
  }

  function render() {
    shown = visibleLayout(isSplitHeld ? heldLayoutOf(layout) : layout, shownTabs);
    for (const tab of PANE_TABS) tabButtonByTab[tab].draggable = !isSplitHeld;
    for (const tab of PANE_TABS) {
      if (!shownTabs.has(tab)) bodyByTab[tab].hidden = true;
    }
    const trailIndex = trailGroupIndex(shown.direction);
    element.dataset.direction = shown.direction ?? 'single';
    const visibleGroups = shown.groups.map((group, visibleIndex) => ({ group, parts: groupParts[visibleIndex] }));
    for (const { group, parts } of visibleGroups) {
      if (!parts) continue;
      replaceChildrenIfChanged(parts.tabList, group.tabs.map((tab) => tabButtonByTab[tab]));
      for (const tab of group.tabs) {
        const isActive = tab === group.activeTab;
        tabButtonByTab[tab].setAttribute('aria-selected', String(isActive));
        tabButtonByTab[tab].tabIndex = isActive ? 0 : -1;
        placeChild(parts.body, bodyByTab[tab]);
        bodyByTab[tab].hidden = !isActive;
      }
      const tools = toolsByTab.get(group.activeTab);
      replaceChildrenIfChanged(parts.tail, tools ? [tools] : []);
      placeStrip(parts, stripHostByTab.get(group.activeTab));
    }
    const [firstParts, secondParts] = groupParts;
    if (!firstParts || !secondParts) return;
    const trailParts = groupParts[trailIndex] ?? firstParts;
    placeChild(trailParts.strip, trailSlot);
    const isSplit = shown.groups.length === 2;
    const children = isSplit ? [firstParts.group, divider, secondParts.group] : [firstParts.group];
    replaceChildrenIfChanged(element, children);
    firstParts.group.style.flex = `${shown.firstShare} 1 0`;
    secondParts.group.style.flex = `${1 - shown.firstShare} 1 0`;
    divider.setAttribute('aria-orientation', shown.direction === 'row' ? 'vertical' : 'horizontal');
    divider.setAttribute('aria-valuenow', String(Math.round(shown.firstShare * 100)));
  }

  function shareAt(event: PointerEvent): number {
    const rect = element.getBoundingClientRect();
    if (shown.direction === 'row') return (event.clientX - rect.left) / rect.width;
    return (event.clientY - rect.top) / rect.height;
  }

  divider.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    divider.setPointerCapture(event.pointerId);
    divider.dataset.dragging = 'true';
    event.preventDefault();
  });
  divider.addEventListener('pointermove', (event) => {
    if (!divider.hasPointerCapture(event.pointerId)) return;
    layout = resizeSplit(layout, shareAt(event));
    render();
  });
  const finishResize = (event: PointerEvent) => {
    if (!divider.hasPointerCapture(event.pointerId)) return;
    divider.releasePointerCapture(event.pointerId);
    delete divider.dataset.dragging;
    setFocusLayout(layout);
  };
  divider.addEventListener('pointerup', finishResize);
  divider.addEventListener('pointercancel', finishResize);
  divider.addEventListener('keydown', (event) => {
    const stepByKey: Record<string, number> = { ArrowLeft: -DIVIDER_KEY_STEP, ArrowUp: -DIVIDER_KEY_STEP, ArrowRight: DIVIDER_KEY_STEP, ArrowDown: DIVIDER_KEY_STEP };
    const step = stepByKey[event.key];
    if (step === undefined || layout.kind !== 'split') return;
    event.preventDefault();
    commit(resizeSplit(layout, layout.firstShare + step));
  });

  render();

  return {
    element,
    trailSlot,
    bodyOf: (tab) => bodyByTab[tab],
    setTabTools: (tab, tools) => {
      if (tools) toolsByTab.set(tab, tools);
      if (!tools) toolsByTab.delete(tab);
      render();
    },
    setTabTitle: (tab, readTitle) => {
      titleReaderByTab.set(tab, readTitle);
      tabButtonByTab[tab].title = readTitle();
    },
    setStripHost: (tab, host) => {
      if (host) stripHostByTab.set(tab, host);
      if (!host) stripHostByTab.delete(tab);
      render();
    },
    showTabs: (nextShownTabs, options) => {
      shownTabs = nextShownTabs;
      isSplitHeld = options?.holdSplit === true;
      render();
    },
    showTab: (tab) => releaseHeldSplitAndCommit(activateTab(layout, tab)),
  };
}
