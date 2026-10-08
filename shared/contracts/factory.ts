import { z } from 'zod';
import { CoherenceOrient, CoherenceReadiness, CoherenceRisk, CoherenceWorkState } from './coherence.ts';

export const FactoryProjectState = z.object({
  projectId: z.string(),
  projectName: z.string(),
  headSha: z.string().nullable(),
  error: z.string().nullable(),
  heading: z.object({ action: CoherenceOrient.shape.action, reasons: z.array(z.string()) }),
  orders: z.array(z.object({
    id: z.string(),
    objective: z.string(),
    criteria: z.array(z.string()),
    risk: CoherenceRisk,
    state: CoherenceWorkState,
    readiness: CoherenceReadiness,
    parent: z.string().nullable(),
    dependsOn: z.array(z.string()),
    writeScopes: z.array(z.string()),
    owner: z.string().nullable(),
    lastEvent: z.object({ event: z.string(), at: z.string(), session: z.string() }).nullable(),
  })),
  conflicts: z.array(z.object({ left: z.string(), right: z.string(), scope: z.string() })),
  unverifiedCompletedWork: z.array(z.string()),
});
export type FactoryProjectState = z.infer<typeof FactoryProjectState>;

export const FactoryState = z.object({
  type: z.literal('factory-state'),
  ts: z.number().finite(),
  projects: z.array(FactoryProjectState),
});
export type FactoryState = z.infer<typeof FactoryState>;
