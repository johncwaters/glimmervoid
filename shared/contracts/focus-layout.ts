import { z } from 'zod';

export const Pane = z.enum(['terminal', 'board', 'shell']);

const SHARE_SUM_TOLERANCE = 0.001;

export const LayoutSplit = z.object({
  kind: z.literal('split'),
  direction: z.enum(['row', 'column']),
  get children(): z.ZodArray<z.ZodUnion<readonly [typeof Pane, typeof LayoutSplit]>> {
    return z.array(z.union([Pane, LayoutSplit])).min(2);
  },
  shares: z.array(z.number().positive()),
}).strict();

export const LayoutNode = z.union([Pane, LayoutSplit]);

export type Pane = z.infer<typeof Pane>;
export type LayoutSplit = z.infer<typeof LayoutSplit>;
export type LayoutNode = z.infer<typeof LayoutNode>;

export function panesOf(node: LayoutNode): Pane[] {
  if (typeof node === 'string') return [node];
  return node.children.flatMap(panesOf);
}

function splitsOf(node: LayoutNode): LayoutSplit[] {
  if (typeof node === 'string') return [];
  return [node, ...node.children.flatMap(splitsOf)];
}

function isWellShared(split: LayoutSplit): boolean {
  const shareTotal = split.shares.reduce((total, share) => total + share, 0);
  return split.shares.length === split.children.length && Math.abs(shareTotal - 1) < SHARE_SUM_TOLERANCE;
}

export const FocusLayout = LayoutNode
  .refine((layout) => splitsOf(layout).every(isWellShared), { error: 'every child of a split takes one share and the shares add up to the whole' })
  .refine((layout) => {
    const panes = panesOf(layout);
    return new Set(panes).size === panes.length;
  }, { error: 'each pane shows at most once' });

export type FocusLayout = z.infer<typeof FocusLayout>;
