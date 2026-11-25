import { z } from 'zod';

import { ModelSelection } from './agent-models.ts';

export const STUDIO_REPO_NAME_MAX = 200;

export const StudioBranchAgent = z.looseObject({ agentId: z.string().min(1), accountId: z.string().min(1).nullable(), setup: ModelSelection.nullable() });
export type StudioBranchAgent = z.infer<typeof StudioBranchAgent>;

export const StudioRepo = z.looseObject({ repoKey: z.string().regex(/^[0-9a-f]{8}$/), repoName: z.string().min(1).max(STUDIO_REPO_NAME_MAX).regex(/^[^/\\]+$/), repoDir: z.string().min(1), branchAgent: StudioBranchAgent.nullable(), addedAtMs: z.number().int().nonnegative() });
export type StudioRepo = z.infer<typeof StudioRepo>;

export const StudioReposFile = z.looseObject({ repos: z.array(z.unknown()) });
export type StudioReposFile = z.infer<typeof StudioReposFile>;
