import { z } from 'zod';
import { SessionPreviewPorts } from '../session-previews.ts';
import { SessionDoc } from '../session.ts';
import { TraceRecord } from '../trace.ts';
import { requestId, sessionId, loose, looseCollection, optionalError, opaqueObject, sessionDocPath } from './control-fields.ts';

export const inspectClientVariants = [
  loose('session-trace', {
    id: sessionId,
    requestId,
    after: z.number().int().nonnegative().default(0),
    endingAt: z.union([z.number().int().nonnegative(), z.literal('tail')]).optional(),
  }),
  loose('session-doc-read', { id: sessionId, path: sessionDocPath, requestId }),
  loose('session-doc-asset-read', { id: sessionId, path: sessionDocPath, src: sessionDocPath, requestId }),
  loose('session-doc-save', { id: sessionId, path: sessionDocPath, text: z.string(), baseHash: z.string().min(1), requestId }),
  loose('session-doc-open', { id: sessionId, path: sessionDocPath, requestId }),
] as const;

export const inspectServerVariants = [
  loose('debug-state-response', { id: sessionId, payload: opaqueObject }),
  loose('session-trace-response', {
    id: sessionId,
    requestId,
    records: z.array(TraceRecord),
    start: z.number().int().nonnegative(),
    next: z.number().int().nonnegative(),
    reset: z.boolean(),
    path: z.string(),
  }),
  loose('session-trace-changed', { id: sessionId }),
  looseCollection('session-docs-changed', { id: sessionId, docs: z.array(SessionDoc) }),
  looseCollection('session-docs-snapshot', { sessions: z.record(z.string(), z.array(SessionDoc)) }),
  loose('session-doc-response', { requestId, id: sessionId, path: z.string(), ok: z.boolean(), text: z.string().optional(), hash: z.string().optional(), error: optionalError }),
  loose('session-doc-asset-response', { requestId, id: sessionId, path: z.string(), src: z.string(), ok: z.boolean(), mime: z.string().optional(), base64: z.string().optional(), error: optionalError }),
  loose('session-doc-open-result', { requestId, id: sessionId, path: z.string(), ok: z.boolean(), error: optionalError }),
  loose('session-doc-save-result', { requestId, id: sessionId, path: z.string(), ok: z.boolean(), hash: z.string().optional(), conflict: z.boolean().optional(), error: optionalError }),
  looseCollection('session-preview-changed', { id: sessionId, port: z.number().int().min(1).max(65535).nullable() }),
  looseCollection('session-previews-snapshot', { ports: SessionPreviewPorts }),
] as const;
