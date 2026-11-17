import { z } from 'zod';
import { ModelSelection } from './agent-models.ts';

const RememberedAgent = z.strictObject({ agentId: z.string().min(1), startedAtMs: z.number() });
const RememberedSelection = z.strictObject({ selection: ModelSelection, pickedAtMs: z.number() });

export const StartPicks = z.strictObject({
  version: z.literal(1),
  agentByPath: z.record(z.string(), RememberedAgent),
  selectionByAgent: z.record(z.string(), RememberedSelection),
});
export type StartPicks = z.infer<typeof StartPicks>;
