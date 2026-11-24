import { z } from 'zod';
import { ConfiguredDefault, ModelSelection } from './agent-models.ts';

const RememberedAgent = z.strictObject({ agentId: z.string().min(1), startedAtMs: z.number() });
const RememberedSelection = z.strictObject({ selection: ModelSelection, pickedAtMs: z.number(), configuredAtPick: ConfiguredDefault.nullable() });

export const StartPicks = z.strictObject({
  version: z.literal(2),
  agentByPath: z.record(z.string(), RememberedAgent),
  selectionByAgent: z.record(z.string(), RememberedSelection),
});
export type StartPicks = z.infer<typeof StartPicks>;

const StartPicksVersion1 = z.strictObject({
  version: z.literal(1),
  agentByPath: z.record(z.string(), RememberedAgent),
  selectionByAgent: z.record(z.string(), z.unknown()),
}).transform((picks): StartPicks => ({ version: 2, agentByPath: picks.agentByPath, selectionByAgent: {} }));

export const StartPicksFile = z.union([StartPicks, StartPicksVersion1]);
