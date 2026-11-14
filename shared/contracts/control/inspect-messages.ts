import { z } from 'zod';
import { COHERENCE_JOURNAL_DRAWER_MAX_ROWS, CoherenceJournalEntry, SessionCoherence } from '../coherence.ts';
import { SessionDoc } from '../session.ts';
import { TraceRecord } from '../trace.ts';
import { requestId, sessionId, loose, optionalError, opaqueObject, sessionDocPath } from './control-fields.ts';

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
  loose('session-coherence-journal', { id: sessionId, requestId }),
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
  loose('session-docs-changed', { id: sessionId, docs: z.array(SessionDoc) }),
  loose('session-docs-snapshot', { sessions: z.record(z.string(), z.array(SessionDoc)) }),
  loose('session-doc-response', { requestId, id: sessionId, path: z.string(), ok: z.boolean(), text: z.string().optional(), hash: z.string().optional(), error: optionalError }),
  loose('session-doc-asset-response', { requestId, id: sessionId, path: z.string(), src: z.string(), ok: z.boolean(), mime: z.string().optional(), base64: z.string().optional(), error: optionalError }),
  loose('session-doc-save-result', { requestId, id: sessionId, path: z.string(), ok: z.boolean(), hash: z.string().optional(), conflict: z.boolean().optional(), error: optionalError }),
  loose('session-coherence', { id: sessionId, ...SessionCoherence.shape }),
  loose('session-coherence-snapshot', { sessions: z.record(z.string(), SessionCoherence) }),
  loose('session-coherence-journal-response', { requestId, id: sessionId, ok: z.boolean(), entries: z.array(CoherenceJournalEntry).max(COHERENCE_JOURNAL_DRAWER_MAX_ROWS), error: optionalError }),
] as const;
