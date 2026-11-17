import { z } from 'zod';

export const PREVIEW_ROUTE = '/app-preview';

const PreviewPort = z.number({ error: 'port must be a number' }).int({ error: 'port must be a whole number' }).min(1, { error: 'port must be from 1 to 65535' }).max(65535, { error: 'port must be from 1 to 65535' });

export const AgentPreviewRequest = z.strictObject({ port: PreviewPort.nullable() });
export type AgentPreviewRequest = z.infer<typeof AgentPreviewRequest>;

export const AgentPreviewReply = z.strictObject({ ok: z.literal(true), path: z.string().nullable(), note: z.string() });
export type AgentPreviewReply = z.infer<typeof AgentPreviewReply>;

export const SessionPreviewPorts = z.record(z.string(), PreviewPort);
