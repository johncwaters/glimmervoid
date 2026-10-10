import { z } from 'zod';

export const CoherenceRisk = z.enum(['low', 'medium', 'high', 'critical']);
export const CoherenceWorkState = z.enum(['open', 'active', 'blocked', 'completed', 'cancelled']);
export const CoherenceReadiness = z.enum(['ready', 'waiting', 'active', 'blocked', 'done']);

const CoherenceWorkStats = z.looseObject({
  total: z.number().int().nonnegative(),
  roots: z.number().int().nonnegative(),
  dependencies: z.number().int().nonnegative(),
  states: z.looseObject({
    open: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
  readiness: z.looseObject({
    ready: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
  }),
  risks: z.looseObject({
    low: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    critical: z.number().int().nonnegative(),
  }),
  graphProblems: z.number().int().nonnegative(),
  scopeOverlaps: z.number().int().nonnegative(),
  scopeConflicts: z.number().int().nonnegative(),
  orphans: z.number().int().nonnegative(),
  unsynthesizedChildren: z.number().int().nonnegative(),
});

export const CoherenceOrient = z.looseObject({
  action: z.enum([
    'steady', 'dispatch', 'continue', 'verify', 'synthesize', 'unblock',
    'resolve-conflict', 'repair-navigation', 'refuse',
  ]),
  reasons: z.array(z.string()),
  sources: z.array(z.looseObject({
    name: z.string(),
    ok: z.boolean(),
    detail: z.string(),
  })),
  work: z.looseObject({
    stats: CoherenceWorkStats,
    ready: z.array(z.string()),
    active: z.array(z.string()),
    blocked: z.array(z.string()),
    completed: z.array(z.string()),
    conflicts: z.array(z.looseObject({
      left: z.string(),
      right: z.string(),
      scope: z.string(),
    })),
    unsynthesized: z.array(z.unknown()),
  }).nullable(),
  consequences: z.looseObject({
    unverifiedCompletedWork: z.array(z.string()),
  }),
  verification: z.looseObject({
    state: z.string(),
  }),
});

export const CoherenceWorkInspect = z.looseObject({
  work: z.array(z.looseObject({
    work: z.string(),
    state: CoherenceWorkState,
    readiness: CoherenceReadiness,
    owner: z.looseObject({
      session: z.string(),
      agent: z.string(),
    }),
    last: z.looseObject({
      event: z.string(),
      at: z.string(),
      session: z.string(),
    }).nullable(),
    opened: z.looseObject({
      at: z.iso.datetime(),
      objective: z.string(),
      authority: z.looseObject({ boundary: z.string() }),
      criteria: z.array(z.string()),
      risk: CoherenceRisk,
      parent: z.string().nullable(),
      dependsOn: z.array(z.string()),
      readScopes: z.array(z.string()),
      writeScopes: z.array(z.string()),
    }),
  })),
  scopeConflicts: z.array(z.looseObject({
    left: z.string(),
    right: z.string(),
    leftScope: z.string(),
    rightScope: z.string(),
    status: z.string(),
  })),
});

export type CoherenceOrient = z.infer<typeof CoherenceOrient>;
export type CoherenceWorkInspect = z.infer<typeof CoherenceWorkInspect>;
export type CoherenceRisk = z.infer<typeof CoherenceRisk>;

export const CoherenceWorkCreated = z.looseObject({
  version: z.literal(1),
  event: z.literal('opened'),
  at: z.iso.datetime(),
  session: z.literal('glimmervoid-factory'),
  work: z.string().regex(/^wrk-[a-f0-9]{16}$/),
  id: z.string().regex(/^wev-[a-f0-9]{16}$/),
  parent: z.null(),
  objective: z.string(),
  criteria: z.array(z.string()),
  risk: CoherenceRisk,
  state: z.literal('open'),
  authority: z.object({ kind: z.literal('user-directed'), grantedBy: z.literal('operator'), boundary: z.string() }),
  writeScopes: z.array(z.string()),
});
