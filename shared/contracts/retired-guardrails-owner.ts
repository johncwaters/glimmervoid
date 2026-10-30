import { z } from 'zod';

export const RetiredGuardrailsOwner = z.object({
  ownerPid: z.number().int().positive(),
  ownerHost: z.string(),
  ownerPidNamespace: z.string().nullable(),
  logins: z.array(z.object({ linkPath: z.string().min(1), targetPath: z.string().min(1) })),
  placeholderPaths: z.array(z.string().min(1)),
});
export type RetiredGuardrailsOwner = z.infer<typeof RetiredGuardrailsOwner>;
