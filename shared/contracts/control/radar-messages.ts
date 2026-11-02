import { z } from 'zod';
import { requestId, loose, nullableString, timestamp, optionalError, opaqueObject, trailSteps } from './control-fields.ts';

export const radarClientVariants = [
  loose('get-radar-report', { issueId: z.union([z.string(), z.number()]), requestId }),
  loose('radar-open-session', { projectId: z.union([z.string(), z.number()]), issueId: z.union([z.string(), z.number()]), requestId }),
  loose('radar-issue-action', { projectId: z.union([z.string(), z.number()]), issueId: z.union([z.string(), z.number()]), action: z.string(), requestId }),
  loose('radar-archive-investigation', { id: z.unknown().optional(), requestId }),
  loose('radar-approve-fix', { id: z.unknown().optional(), requestId }),
  loose('radar-dismiss-fix', { id: z.unknown().optional(), requestId }),
] as const;

export const radarServerVariants = [
  loose('radar-status', {
    ts: timestamp,
    intervalMinutes: z.number(),
    projects: z.array(opaqueObject),
    investigations: z.array(opaqueObject),
  }),
  loose('radar-investigation-activity', {
    projectId: z.union([z.string(), z.number()]),
    issueId: z.string(),
    inFlight: z.literal(true),
    startedAt: timestamp.nullable(),
    trail: trailSteps,
  }),
  loose('radar-investigation-finished', {
    projectId: z.union([z.string(), z.number()]),
    issueId: z.string(),
    verdict: z.string(),
    summaryLine: nullableString,
    startedAt: timestamp.nullable(),
    trail: trailSteps,
  }),
  loose('radar-report', {
    requestId,
    ok: z.boolean(),
    found: z.boolean(),
    issueId: nullableString,
    format: z.string().optional(),
    content: z.string().optional(),
    message: z.string().optional(),
    error: z.string().optional(),
  }),
  loose('radar-open-session-result', {
    requestId,
    ok: z.boolean(),
    error: optionalError,
    sessionId: z.string().optional(),
    sessionName: z.string().optional(),
    pending: z.boolean().optional(),
  }),
  loose('radar-issue-action-result', {
    requestId,
    ok: z.boolean(),
    error: optionalError,
    status: nullableString.optional(),
  }),
  loose('radar-archive-investigation-result', { requestId, ok: z.boolean(), error: optionalError }),
  loose('radar-approve-fix-result', { requestId, ok: z.boolean(), error: optionalError, sessionId: z.string().optional(), sessionName: z.string().optional() }),
  loose('radar-dismiss-fix-result', { requestId, ok: z.boolean(), error: optionalError }),
] as const;
