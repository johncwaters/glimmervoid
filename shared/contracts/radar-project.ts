import { z } from 'zod';

const RadarProjectId = z.union([z.string().min(1), z.number().int()]);

const RadarTrafficObservation = z.object({
  currentUsers: z.number().nonnegative(),
  buckets: z.array(z.object({ bucket: z.unknown(), users: z.number().nonnegative() }).strict()),
}).strict();

export const RadarProjectPayload = z.object({
  observedAt: z.iso.datetime(),
  host: z.string().min(1),
  projectId: RadarProjectId,
  projectName: z.string(),
  error: z.string().nullable(),
  issuesBody: z.unknown(),
  spikesBody: z.unknown(),
  traffic: RadarTrafficObservation.nullable(),
  trafficError: z.string().nullable(),
  dailyVolumeRows: z.array(z.record(z.string(), z.unknown())).nullable(),
}).strict();

export type RadarProjectPayload = z.infer<typeof RadarProjectPayload>;
