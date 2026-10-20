import { z } from 'zod';

export const CoderOwnedWorkspaces = z.object({
  version: z.literal(1),
  workspaces: z.array(z.string().regex(/^gv-[0-9a-f]{12}$/)),
});

export type CoderOwnedWorkspaces = z.infer<typeof CoderOwnedWorkspaces>;
