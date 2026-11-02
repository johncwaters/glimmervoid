import { z } from 'zod';

export const PaneTab = z.enum(['terminal', 'board']);

export const PaneGroup = z.object({
  kind: z.literal('group'),
  tabs: z.array(PaneTab).min(1).max(2),
  activeTab: PaneTab,
}).strict().refine((group) => group.tabs.includes(group.activeTab), { error: 'the active tab must be one of the group tabs' });

const PaneSplit = z.object({
  kind: z.literal('split'),
  direction: z.enum(['row', 'column']),
  firstShare: z.number().min(0.15).max(0.85),
  children: z.tuple([PaneGroup, PaneGroup]),
}).strict();

const tabsOf = (layout: z.infer<typeof PaneGroup> | z.infer<typeof PaneSplit>) =>
  layout.kind === 'group' ? layout.tabs : layout.children.flatMap((group) => group.tabs);

export const FocusLayout = z.union([PaneGroup, PaneSplit]).refine((layout) => {
  const tabs = tabsOf(layout);
  return tabs.length === PaneTab.options.length && PaneTab.options.every((tab) => tabs.includes(tab));
}, { error: 'every pane tab appears exactly once' });

export type PaneTab = z.infer<typeof PaneTab>;
export type PaneGroup = z.infer<typeof PaneGroup>;
export type PaneSplit = z.infer<typeof PaneSplit>;
export type FocusLayout = z.infer<typeof FocusLayout>;
