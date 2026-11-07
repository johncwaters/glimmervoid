import { z } from 'zod';
import { WorkflowPr } from './workflows.ts';

export const WorkflowsCandidatesPayload = z.object({
  observedAt: z.iso.datetime(),
  viewer: z.string().min(1),
  repo: z.string().min(1),
  isComplete: z.boolean(),
  prs: z.array(WorkflowPr),
}).strict();

export type WorkflowsCandidatesPayload = z.infer<typeof WorkflowsCandidatesPayload>;
