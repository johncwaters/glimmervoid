import { FocusLayout, type LayoutNode, Pane, panesOf } from '#shared/contracts/focus-layout.ts';
import type { LayoutSplit } from '#shared/contracts/focus-layout.ts';
import { z } from 'zod';

export type DropZone = 'top' | 'bottom' | 'left' | 'right';

export interface VisibleSplit {
  direction: LayoutSplit['direction'];
  children: VisibleNode[];
  shares: number[];
  sourcePath: number[];
  sourceIndexes: number[];
}

export type VisibleNode = Pane | VisibleSplit;

const MIN_VISIBLE_SHARE = 0.1;
const NEW_PANE_SHARE = 0.35;
const EVERY_PANE: readonly Pane[] = Pane.options;

export const DEFAULT_FOCUS_LAYOUT: FocusLayout = {
  kind: 'split',
  direction: 'column',
  children: [{ kind: 'split', direction: 'row', children: ['terminal', 'board'], shares: [0.5, 0.5] }, 'shell'],
  shares: [0.65, 0.35],
};

const FlatSplit = z.object({
  kind: z.literal('split'),
  direction: z.enum(['row', 'column']),
  firstShare: z.number().min(0.05).max(0.95),
  first: Pane,
  second: Pane,
});

function migrateFlatSplit(stored: unknown): FocusLayout | null {
  const flat = FlatSplit.safeParse(stored);
  if (!flat.success || flat.data.first === flat.data.second) return null;
  return { kind: 'split', direction: flat.data.direction, children: [flat.data.first, flat.data.second], shares: [flat.data.firstShare, 1 - flat.data.firstShare] };
}

function withEveryPane(layout: FocusLayout): FocusLayout {
  const present = new Set(panesOf(layout));
  return EVERY_PANE.filter((pane) => !present.has(pane)).reduce<FocusLayout>((grown, missingPane) => ({
    kind: 'split',
    direction: 'column',
    children: [grown, missingPane],
    shares: [1 - NEW_PANE_SHARE, NEW_PANE_SHARE],
  }), layout);
}

export function parseFocusLayout(stored: unknown): FocusLayout {
  const parsed = FocusLayout.safeParse(stored);
  if (parsed.success) return withEveryPane(parsed.data);
  const migrated = migrateFlatSplit(stored);
  return migrated ? withEveryPane(migrated) : DEFAULT_FOCUS_LAYOUT;
}

export function dropZoneAt(pointX: number, pointY: number, rect: { width: number; height: number }): DropZone {
  const distanceByZone: [DropZone, number][] = [
    ['left', pointX / rect.width],
    ['right', 1 - pointX / rect.width],
    ['top', pointY / rect.height],
    ['bottom', 1 - pointY / rect.height],
  ];
  return distanceByZone.reduce((nearest, candidate) => (candidate[1] < nearest[1] ? candidate : nearest))[0];
}

function normalizeShares(shares: number[]): number[] {
  const total = shares.reduce((sum, share) => sum + share, 0);
  return shares.map((share) => share / total);
}

function flattenSameDirection(split: LayoutSplit): LayoutSplit {
  const children: LayoutNode[] = [];
  const shares: number[] = [];
  split.children.forEach((child, index) => {
    const share = split.shares[index] ?? 0;
    if (typeof child === 'string' || child.direction !== split.direction) {
      children.push(child);
      shares.push(share);
      return;
    }
    children.push(...child.children);
    shares.push(...child.shares.map((childShare) => childShare * share));
  });
  return { ...split, children, shares };
}

function withoutPane(node: LayoutNode, removedPane: Pane): LayoutNode | null {
  if (typeof node === 'string') return node === removedPane ? null : node;
  const keptChildren: LayoutNode[] = [];
  const keptShares: number[] = [];
  node.children.forEach((child, index) => {
    const kept = withoutPane(child, removedPane);
    if (kept === null) return;
    keptChildren.push(kept);
    keptShares.push(node.shares[index] ?? 0);
  });
  const [onlyChild] = keptChildren;
  if (keptChildren.length === 0) return null;
  if (keptChildren.length === 1 && onlyChild !== undefined) return onlyChild;
  return flattenSameDirection({ ...node, children: keptChildren, shares: normalizeShares(keptShares) });
}

function besideTarget(node: LayoutNode, movedPane: Pane, targetPane: Pane, zone: DropZone): LayoutNode {
  const direction: LayoutSplit['direction'] = zone === 'left' || zone === 'right' ? 'row' : 'column';
  const isMovedFirst = zone === 'left' || zone === 'top';
  if (node === targetPane) {
    return { kind: 'split', direction, children: isMovedFirst ? [movedPane, targetPane] : [targetPane, movedPane], shares: [0.5, 0.5] };
  }
  if (typeof node === 'string') return node;
  const targetIndex = node.children.indexOf(targetPane);
  if (targetIndex >= 0 && node.direction === direction) {
    const halfShare = (node.shares[targetIndex] ?? 0) / 2;
    const insertAt = isMovedFirst ? targetIndex : targetIndex + 1;
    const shares = node.shares.with(targetIndex, halfShare);
    return { ...node, children: node.children.toSpliced(insertAt, 0, movedPane), shares: shares.toSpliced(insertAt, 0, halfShare) };
  }
  return { ...node, children: node.children.map((child) => besideTarget(child, movedPane, targetPane, zone)) };
}

export function movePane(layout: FocusLayout, movedPane: Pane, targetPane: Pane, zone: DropZone): FocusLayout {
  if (movedPane === targetPane) return layout;
  const remaining = withoutPane(layout, movedPane);
  if (remaining === null) return layout;
  return besideTarget(remaining, movedPane, targetPane, zone);
}

function visibleNodeOf(node: LayoutNode, shownPanes: ReadonlySet<Pane>, sourcePath: number[]): VisibleNode | null {
  if (typeof node === 'string') return shownPanes.has(node) ? node : null;
  const children: VisibleNode[] = [];
  const sourceIndexes: number[] = [];
  const shares: number[] = [];
  node.children.forEach((child, index) => {
    const visibleChild = visibleNodeOf(child, shownPanes, [...sourcePath, index]);
    if (visibleChild === null) return;
    children.push(visibleChild);
    sourceIndexes.push(index);
    shares.push(node.shares[index] ?? 0);
  });
  const [onlyChild] = children;
  if (children.length === 0) return null;
  if (children.length === 1 && onlyChild !== undefined) return onlyChild;
  return { direction: node.direction, children, shares: normalizeShares(shares), sourcePath, sourceIndexes };
}

export function visibleLayout(layout: FocusLayout, shownPanes: ReadonlySet<Pane>): VisibleNode | null {
  return visibleNodeOf(layout, shownPanes, []);
}

export function resizeVisiblePair(shares: readonly number[], dividerIndex: number, positionFraction: number): number[] {
  const before = shares[dividerIndex];
  const after = shares[dividerIndex + 1];
  if (before === undefined || after === undefined || !Number.isFinite(positionFraction)) return [...shares];
  const start = shares.slice(0, dividerIndex).reduce((sum, share) => sum + share, 0);
  const pairTotal = before + after;
  const minShare = Math.min(MIN_VISIBLE_SHARE, pairTotal / 2);
  const resizedBefore = Math.min(pairTotal - minShare, Math.max(minShare, positionFraction - start));
  return shares.with(dividerIndex, resizedBefore).with(dividerIndex + 1, pairTotal - resizedBefore);
}

function withResizedSplit(node: LayoutNode, split: VisibleSplit, visibleShares: readonly number[], depth: number): LayoutNode {
  if (typeof node === 'string') return node;
  if (depth < split.sourcePath.length) {
    const childIndex = split.sourcePath[depth];
    return { ...node, children: node.children.map((child, index) => (index === childIndex ? withResizedSplit(child, split, visibleShares, depth + 1) : child)) };
  }
  const visibleTotal = split.sourceIndexes.reduce((sum, sourceIndex) => sum + (node.shares[sourceIndex] ?? 0), 0);
  const shares = split.sourceIndexes.reduce((resized, sourceIndex, visibleIndex) => resized.with(sourceIndex, (visibleShares[visibleIndex] ?? 0) * visibleTotal), node.shares);
  return { ...node, shares };
}

export function resizeSplit(layout: FocusLayout, split: VisibleSplit, visibleShares: readonly number[]): FocusLayout {
  if (visibleShares.length !== split.sourceIndexes.length) return layout;
  return withResizedSplit(layout, split, visibleShares, 0);
}
