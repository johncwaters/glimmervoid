import { FocusLayout } from '#shared/contracts/focus-layout.ts';
import type { PaneGroup, PaneSplit, PaneTab } from '#shared/contracts/focus-layout.ts';

type DropZone = 'top' | 'bottom' | 'left' | 'right' | 'join';

const MIN_SHARE = 0.15;
const MAX_SHARE = 0.85;
const EDGE_FRACTION = 0.25;

export const DEFAULT_FOCUS_LAYOUT: FocusLayout = {
  kind: 'split',
  direction: 'column',
  firstShare: 0.6,
  children: [
    { kind: 'group', tabs: ['board'], activeTab: 'board' },
    { kind: 'group', tabs: ['terminal'], activeTab: 'terminal' },
  ],
};

export function parseFocusLayout(stored: unknown): FocusLayout {
  const parsed = FocusLayout.safeParse(stored);
  return parsed.success ? parsed.data : DEFAULT_FOCUS_LAYOUT;
}

export function groupsOf(layout: FocusLayout): PaneGroup[] {
  return layout.kind === 'group' ? [layout] : [...layout.children];
}

export function trailGroupIndex(direction: PaneSplit['direction'] | null): number {
  return direction === 'row' ? 1 : 0;
}

export function dropZoneAt(pointX: number, pointY: number, rect: { width: number; height: number }): DropZone {
  const distanceByZone: [DropZone, number][] = [
    ['left', pointX / rect.width],
    ['right', 1 - pointX / rect.width],
    ['top', pointY / rect.height],
    ['bottom', 1 - pointY / rect.height],
  ];
  const [nearestZone, nearestDistance] = distanceByZone.reduce((nearest, candidate) => (candidate[1] < nearest[1] ? candidate : nearest));
  return nearestDistance < EDGE_FRACTION ? nearestZone : 'join';
}

function groupWithout(group: PaneGroup, tab: PaneTab): PaneGroup | null {
  const tabs = group.tabs.filter((candidate) => candidate !== tab);
  const [firstTab] = tabs;
  if (!firstTab) return null;
  return { kind: 'group', tabs, activeTab: tabs.includes(group.activeTab) ? group.activeTab : firstTab };
}

function splitAround(target: PaneGroup, tab: PaneTab, zone: Exclude<DropZone, 'join'>): PaneSplit {
  const moved: PaneGroup = { kind: 'group', tabs: [tab], activeTab: tab };
  const direction = zone === 'left' || zone === 'right' ? 'row' : 'column';
  const isMovedFirst = zone === 'left' || zone === 'top';
  return { kind: 'split', direction, firstShare: 0.5, children: isMovedFirst ? [moved, target] : [target, moved] };
}

export function moveTab(layout: FocusLayout, tab: PaneTab, targetGroupIndex: number, zone: DropZone): FocusLayout {
  const groups = groupsOf(layout);
  const target = groups[targetGroupIndex];
  if (!target) return layout;
  const targetAfterRemoval = groupWithout(target, tab);
  const remaining = groups.flatMap((group) => groupWithout(group, tab) ?? []);
  const [onlyRemaining] = remaining;
  if (zone === 'join') {
    if (target.tabs.includes(tab)) return activateTab(layout, tab);
    if (remaining.length !== 1 || !onlyRemaining) return layout;
    return { kind: 'group', tabs: [...onlyRemaining.tabs, tab], activeTab: tab };
  }
  if (!targetAfterRemoval || remaining.length !== 1) return layout;
  return splitAround(targetAfterRemoval, tab, zone);
}

export function resizeSplit(layout: FocusLayout, firstShare: number): FocusLayout {
  if (layout.kind === 'group' || !Number.isFinite(firstShare)) return layout;
  return { ...layout, firstShare: Math.min(MAX_SHARE, Math.max(MIN_SHARE, firstShare)) };
}

export function activateTab(layout: FocusLayout, tab: PaneTab): FocusLayout {
  const activate = (group: PaneGroup): PaneGroup => (group.tabs.includes(tab) && group.activeTab !== tab ? { ...group, activeTab: tab } : group);
  if (layout.kind === 'group') return activate(layout);
  const [first, second] = layout.children;
  const [activatedFirst, activatedSecond] = [activate(first), activate(second)];
  if (activatedFirst === first && activatedSecond === second) return layout;
  return { ...layout, children: [activatedFirst, activatedSecond] };
}

export interface VisibleLayout {
  groups: PaneGroup[];
  groupIndexes: number[];
  direction: PaneSplit['direction'] | null;
  firstShare: number;
}

export function visibleLayout(layout: FocusLayout, shownTabs: ReadonlySet<PaneTab>): VisibleLayout {
  const shown = groupsOf(layout).flatMap((group, groupIndex) => {
    const tabs = group.tabs.filter((tab) => shownTabs.has(tab));
    const [firstTab] = tabs;
    if (!firstTab) return [];
    return [{ group: { kind: 'group' as const, tabs, activeTab: tabs.includes(group.activeTab) ? group.activeTab : firstTab }, groupIndex }];
  });
  const isSplitShown = layout.kind === 'split' && shown.length === 2;
  return {
    groups: shown.map(({ group }) => group),
    groupIndexes: shown.map(({ groupIndex }) => groupIndex),
    direction: isSplitShown ? layout.direction : null,
    firstShare: isSplitShown ? layout.firstShare : 1,
  };
}
