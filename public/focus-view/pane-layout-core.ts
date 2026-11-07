import { FocusLayout, Pane } from '#shared/contracts/focus-layout.ts';
import { z } from 'zod';

type BoardDropZone = 'top' | 'bottom' | 'left' | 'right';

const MIN_SHARE = 0.15;
const MAX_SHARE = 0.85;

export const DEFAULT_FOCUS_LAYOUT: FocusLayout = {
  kind: 'split',
  direction: 'row',
  firstShare: 0.5,
  first: 'terminal',
  second: 'board',
};

const TabbedSplit = z.object({
  kind: z.literal('split'),
  direction: z.enum(['row', 'column']),
  firstShare: z.number(),
  children: z.tuple([z.object({ tabs: z.tuple([Pane]) }), z.object({ tabs: z.tuple([Pane]) })]),
});

function migrateTabbedLayout(stored: unknown): FocusLayout | null {
  const tabbed = TabbedSplit.safeParse(stored);
  if (!tabbed.success) return null;
  const [firstGroup, secondGroup] = tabbed.data.children;
  const migrated = FocusLayout.safeParse({
    kind: 'split',
    direction: tabbed.data.direction,
    firstShare: tabbed.data.firstShare,
    first: firstGroup.tabs[0],
    second: secondGroup.tabs[0],
  });
  return migrated.success ? migrated.data : null;
}

export function parseFocusLayout(stored: unknown): FocusLayout {
  const parsed = FocusLayout.safeParse(stored);
  if (parsed.success) return parsed.data;
  return migrateTabbedLayout(stored) ?? DEFAULT_FOCUS_LAYOUT;
}

export function dropZoneAt(pointX: number, pointY: number, rect: { width: number; height: number }): BoardDropZone {
  const distanceByZone: [BoardDropZone, number][] = [
    ['left', pointX / rect.width],
    ['right', 1 - pointX / rect.width],
    ['top', pointY / rect.height],
    ['bottom', 1 - pointY / rect.height],
  ];
  return distanceByZone.reduce((nearest, candidate) => (candidate[1] < nearest[1] ? candidate : nearest))[0];
}

export function moveBoard(layout: FocusLayout, zone: BoardDropZone): FocusLayout {
  const boardShare = layout.first === 'board' ? layout.firstShare : 1 - layout.firstShare;
  const isBoardFirst = zone === 'left' || zone === 'top';
  return {
    kind: 'split',
    direction: zone === 'left' || zone === 'right' ? 'row' : 'column',
    firstShare: isBoardFirst ? boardShare : 1 - boardShare,
    first: isBoardFirst ? 'board' : 'terminal',
    second: isBoardFirst ? 'terminal' : 'board',
  };
}

export function resizeSplit(layout: FocusLayout, firstShare: number): FocusLayout {
  if (!Number.isFinite(firstShare)) return layout;
  return { ...layout, firstShare: Math.min(MAX_SHARE, Math.max(MIN_SHARE, firstShare)) };
}
