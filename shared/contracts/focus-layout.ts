import { z } from 'zod';

export const Pane = z.enum(['terminal', 'board']);

export const FocusLayout = z.object({
  kind: z.literal('split'),
  direction: z.enum(['row', 'column']),
  firstShare: z.number().min(0.15).max(0.85),
  first: Pane,
  second: Pane,
}).strict().refine((layout) => layout.first !== layout.second, { error: 'the terminal and the board each take one side' });

export type Pane = z.infer<typeof Pane>;
export type FocusLayout = z.infer<typeof FocusLayout>;
