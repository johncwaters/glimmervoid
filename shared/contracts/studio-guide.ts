import { z } from 'zod';

export const StudioGuideStep = z.enum(['talk', 'branch', 'diff', 'progress']);
export type StudioGuideStep = z.infer<typeof StudioGuideStep>;

export const StudioGuideState = z.object({ doneSteps: z.array(StudioGuideStep).default([]) });
export type StudioGuideState = z.infer<typeof StudioGuideState>;
