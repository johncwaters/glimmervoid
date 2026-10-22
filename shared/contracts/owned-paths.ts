import { z } from 'zod';

export const OwnedPathOwner = z.string().regex(/^(session|lane):[A-Za-z0-9._:#-]+$/);
export type OwnedPathOwner = z.infer<typeof OwnedPathOwner>;

export const OwnedPathEntry = z.object({
  path: z.string().min(1),
  owner: OwnedPathOwner,
  kind: z.enum(['git-worktree', 'folder']),
  projectPath: z.string().min(1).nullable(),
  branch: z.string().min(1).nullable(),
}).strict();
export type OwnedPathEntry = z.infer<typeof OwnedPathEntry>;

export const OwnedPathsLedger = z.object({
  version: z.literal(1),
  entries: z.array(OwnedPathEntry),
}).strict();
export type OwnedPathsLedger = z.infer<typeof OwnedPathsLedger>;
