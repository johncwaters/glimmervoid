import { z } from 'zod';

export const HostReadyRowId = z.enum(['github', 'git-identity', 'gh', 'commit-signing']);
export type HostReadyRowId = z.infer<typeof HostReadyRowId>;
export const HostReadyState = z.enum(['ready', 'needs-action', 'unavailable']);
export type HostReadyState = z.infer<typeof HostReadyState>;
export const HostReadyFix = z.enum(['connect-github', 'set-up-signing', 'register-signing']);
export type HostReadyFix = z.infer<typeof HostReadyFix>;

export const HostReadyRow = z.strictObject({ id: HostReadyRowId, state: HostReadyState, text: z.string().min(1), fix: HostReadyFix.nullable() });
export type HostReadyRow = z.infer<typeof HostReadyRow>;

export const HostReady = z.strictObject({ rows: z.array(HostReadyRow) });
export type HostReady = z.infer<typeof HostReady>;
