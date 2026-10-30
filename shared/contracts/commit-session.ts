import { z } from 'zod';

const CommitSha = z.string().regex(/^[0-9a-f]{40}$/);

export const CommitSessionRecord = z.object({
  sha: CommitSha,
  patchId: CommitSha.nullable(),
  sessionId: z.string().min(1).max(64),
  sessionName: z.string().max(200),
  agent: z.string().max(64),
  taskTitle: z.string().max(300).nullable(),
  committedAt: z.number().int(),
  recordedAt: z.number().int(),
}).strict();

export type CommitSessionRecord = z.infer<typeof CommitSessionRecord>;
