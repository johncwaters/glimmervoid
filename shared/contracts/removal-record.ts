import { z } from 'zod';

const REMOVAL_CAUSES = [
  'branch-gc', 'boot-reconcile', 'owned-paths', 'host-scratch', 'guardrails-temp', 'session-temp', 'guardrails-leftovers', 'aged-files',
  'update-apply', 'team-review', 'benchmark', 'radar', 'session', 'session-create', 'merge',
] as const;

export const RemovalRecord = z.object({
  ts: z.number(),
  cause: z.enum(REMOVAL_CAUSES),
  kind: z.enum(['folder', 'file', 'worktree', 'local-branch', 'remote-branch']),
  path: z.string().nullable(),
  branch: z.string().nullable(),
  projectPath: z.string().nullable(),
  sessionId: z.string().nullable(),
  checksPassed: z.array(z.string()),
  pid: z.number(),
}).strict();
export type RemovalRecord = z.infer<typeof RemovalRecord>;
export type RemovalCause = RemovalRecord['cause'];
export type RemovalKind = RemovalRecord['kind'];
