import { z } from 'zod';

const setupName = z.string().max(16384);
const setupNames = z.array(setupName).max(4096);

export const SessionSetup = z.object({
  model: setupName.nullable(),
  mcpServers: setupNames,
  plugins: z.array(z.object({ name: setupName, skills: setupNames, agents: setupNames })).max(4096),
  skills: setupNames,
  agents: setupNames,
  hookEvents: z.array(z.object({ event: setupName, runCount: z.number().int().nonnegative() })).max(4096),
  hookCommands: z.array(z.string().max(65536)).max(4096),
});
export type SessionSetup = z.infer<typeof SessionSetup>;
