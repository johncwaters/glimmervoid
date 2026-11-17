import { z } from 'zod';

const ClaimPath = z.string({ error: 'path must be a string' }).min(1, { error: 'path must not be empty' }).max(1000, { error: 'path must be at most 1000 characters' });

export const AgentClaimRequest = z.discriminatedUnion('sub', [
  z.strictObject({ sub: z.literal('add'), path: ClaimPath }),
  z.strictObject({ sub: z.literal('release'), path: ClaimPath }),
  z.strictObject({ sub: z.literal('list') }),
], { error: 'claim takes add, release or list' });
export type AgentClaimRequest = z.infer<typeof AgentClaimRequest>;

const ClaimView = z.strictObject({ path: z.string(), holderId: z.string(), holderName: z.string(), claimedAt: z.number() });

export const AgentClaimReply = z.union([
  z.strictObject({ ok: z.literal(true), claimed: z.string(), note: z.string() }),
  z.strictObject({ ok: z.literal(true), released: z.string() }),
  z.strictObject({ ok: z.literal(true), claims: z.array(ClaimView) }),
]);
export type AgentClaimReply = z.infer<typeof AgentClaimReply>;
