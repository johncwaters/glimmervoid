import { z } from 'zod';
import { DONE_MEANS_MAX_LINES } from './session.ts';

const VERIFICATION_CHECK_LIMIT = 12;
export const VERIFICATION_OUTPUT_TAIL_BYTES = 4000;

export const AGENT_DONE_CHECK_ID_PREFIX = 'agent-done-';
const VERIFICATION_RUN_CHECK_LIMIT = VERIFICATION_CHECK_LIMIT + DONE_MEANS_MAX_LINES + 1;

const checkId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

const configCheckId = checkId.refine((id) => !id.startsWith(AGENT_DONE_CHECK_ID_PREFIX), { error: `check ids starting ${AGENT_DONE_CHECK_ID_PREFIX} are kept for the agent's Done means commands` });

const VerificationCheckSpec = z.strictObject({
  id: configCheckId,
  command: z.string().min(1).max(400),
});

export const VerificationSettings = z.strictObject({
  checks: z.array(VerificationCheckSpec).max(VERIFICATION_CHECK_LIMIT).default([]),
  timeoutSeconds: z.number().int().min(5).max(1800).default(300),
  gate: z.strictObject({
    enabled: z.boolean().default(false),
    required: z.array(configCheckId).max(VERIFICATION_CHECK_LIMIT).optional(),
  }).default({ enabled: false }),
});

const CHECK_STATUSES = ['pass', 'fail', 'timeout', 'skipped'] as const;

export const CheckOutcome = z.strictObject({
  id: checkId,
  command: z.string(),
  status: z.enum(CHECK_STATUSES),
  exitCode: z.number().int().nullable(),
  outputTail: z.string().max(VERIFICATION_OUTPUT_TAIL_BYTES * 2),
});

const VERIFICATION_STATUSES = ['running', 'passed', 'failed'] as const;

export const REMOVED_TEST_LINE_LIMIT = 20;

const RemovedTestLine = z.strictObject({
  path: z.string().min(1),
  line: z.number().int().min(0),
  text: z.string().max(200),
  kind: z.enum(['removed-assertion', 'removed-test', 'added-skip']),
});

export const VerificationRun = z.strictObject({
  sessionId: z.string().min(1),
  sig: z.string(),
  status: z.enum(VERIFICATION_STATUSES),
  checks: z.array(CheckOutcome).max(VERIFICATION_RUN_CHECK_LIMIT),
  finishedAt: z.number().int().nullable(),
  removedTestLines: z.array(RemovedTestLine).max(REMOVED_TEST_LINE_LIMIT).nullable().default(null),
});

export type VerificationSettings = z.infer<typeof VerificationSettings>;
export type CheckOutcome = z.infer<typeof CheckOutcome>;
export type VerificationRun = z.infer<typeof VerificationRun>;
export type RemovedTestLine = z.infer<typeof RemovedTestLine>;
