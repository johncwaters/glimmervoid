import { z } from 'zod';

const StudioBranchAgent = z.looseObject({ agentId: z.string().min(1), model: z.string().min(1).nullable(), accountId: z.string().min(1).nullable() });

export const StudioRepo = z.looseObject({ repoKey: z.string().regex(/^[0-9a-f]{8}$/), repoName: z.string().min(1).regex(/^[^/\\]+$/), repoDir: z.string().min(1), branchAgent: StudioBranchAgent.nullable(), addedAtMs: z.number().int().nonnegative() });
export type StudioRepo = z.infer<typeof StudioRepo>;

export const StudioReposFile = z.looseObject({ repos: z.array(z.unknown()) });
export type StudioReposFile = z.infer<typeof StudioReposFile>;
