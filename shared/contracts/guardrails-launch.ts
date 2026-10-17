import { z } from 'zod';

const GuardrailsLaunchLogin = z.object({
  linkPath: z.string().min(1),
  targetPath: z.string().min(1),
}).strict();

export const GuardrailsLaunchOwner = z.object({
  ownerPid: z.number().int().positive(),
  ownerHost: z.string(),
  ownerPidNamespace: z.string().nullable(),
  ownsTempDir: z.boolean(),
  logins: z.array(GuardrailsLaunchLogin),
  placeholderPaths: z.array(z.string().min(1)),
}).strict();
export type GuardrailsLaunchOwner = z.infer<typeof GuardrailsLaunchOwner>;
