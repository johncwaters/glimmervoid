import { z } from 'zod';
import { CHAT_SEND_MAX_ATTACHMENTS, UploadFileName, UsageLimit } from './session.ts';

export const MAX_RAW_LINE_CHARS = 4000;
export const CONVERSATION_EVENTS_HOOK_EVENT = 'ConversationEvents';
export const MAX_RECORD_IMAGES = 8;

export const TraceImage = z.strictObject({
  fileName: UploadFileName,
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  byteSize: z.number().int().positive(),
});
export type TraceImage = z.infer<typeof TraceImage>;

const TraceRecordBase = z.object({
  ts: z.number().finite(),
  uuid: z.string().nullable(),
  parentUuid: z.string().nullable(),
  vendorSessionId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  agentType: z.string().min(1).optional(),
  transcriptOffset: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
});

export const SUBAGENT_SIGNAL_EVENT = 'subagent-signal';

const SubagentSignalFields = {
  phase: z.enum(['start', 'stop']),
  subagentId: z.string().min(1),
  subagentType: z.string().min(1).nullable(),
  task: z.string().min(1).nullable(),
};

export const SubagentSignal = z.strictObject({ ...SubagentSignalFields, ts: z.number() });
export type SubagentSignal = z.infer<typeof SubagentSignal>;

export const BACKGROUND_TASK_SIGNAL_EVENT = 'background-task-signal';

const BackgroundTaskSignalFields = {
  phase: z.enum(['start', 'stop']),
  taskId: z.string().min(1),
  taskType: z.string().min(1).nullable(),
};

export const BackgroundTaskSignal = z.strictObject({ ...BackgroundTaskSignalFields, ts: z.number() });
export type BackgroundTaskSignal = z.infer<typeof BackgroundTaskSignal>;

export const TraceRecord = z.discriminatedUnion('kind', [
  TraceRecordBase.extend({
    kind: z.literal('prompt'),
    text: z.string(),
  }),
  TraceRecordBase.extend({
    kind: z.literal('expansion'),
    text: z.string(),
    toolUseId: z.string().min(1).optional(),
    midTurn: z.literal(true).optional(),
  }),
  TraceRecordBase.extend({
    kind: z.literal('thinking'),
    text: z.string(),
  }),
  TraceRecordBase.extend({
    kind: z.literal('assistant'),
    text: z.string(),
  }),
  TraceRecordBase.extend({
    kind: z.literal('tool_call'),
    toolUseId: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
  }),
  TraceRecordBase.extend({
    kind: z.literal('tool_result'),
    toolUseId: z.string().min(1),
    content: z.string(),
    isError: z.boolean(),
    truncated: z.boolean(),
    subagentId: z.string().min(1).optional(),
    backgroundTaskId: z.string().min(1).optional(),
    backgroundTaskName: z.string().min(1).optional(),
    backgroundTaskSummary: z.string().min(1).optional(),
    images: z.array(TraceImage).min(1).max(MAX_RECORD_IMAGES).optional(),
  }),
  TraceRecordBase.extend({ kind: z.literal('subagent'), ...SubagentSignalFields }),
  TraceRecordBase.extend({ kind: z.literal('background-task'), ...BackgroundTaskSignalFields }),
  TraceRecordBase.extend({
    kind: z.literal('session'),
    vendor: z.string().min(1),
    transcriptPath: z.string().min(1),
    reason: z.string().min(1).optional(),
  }),
  TraceRecordBase.extend({
    kind: z.literal('attachments'),
    files: z.array(UploadFileName).min(1).max(CHAT_SEND_MAX_ATTACHMENTS),
    pastedPrefix: z.string().max(MAX_RAW_LINE_CHARS),
    fromTranscript: z.literal(true).optional(),
  }),
  TraceRecordBase.extend({ kind: z.literal('board-answer') }),
  TraceRecordBase.extend({
    kind: z.literal('usage_limit'),
    text: z.string().max(MAX_RAW_LINE_CHARS),
    ...UsageLimit.shape,
  }),
  TraceRecordBase.extend({
    kind: z.literal('notice'),
    text: z.string().max(MAX_RAW_LINE_CHARS),
  }),
  TraceRecordBase.extend({
    kind: z.literal('command-output'),
    text: z.string().max(MAX_RAW_LINE_CHARS),
    isError: z.boolean(),
  }),
  TraceRecordBase.extend({
    kind: z.literal('model-change'),
    model: z.string().min(1).max(200),
  }),
  TraceRecordBase.extend({
    kind: z.literal('raw'),
    line: z.string().max(MAX_RAW_LINE_CHARS),
  }),
]);

export type TraceRecord = z.infer<typeof TraceRecord>;

export const TraceCheckpoint = z.object({
  transcriptPath: z.string().min(1),
  vendorSessionId: z.string().min(1),
  offset: z.number().int().nonnegative(),
  ingestedSubagentPaths: z.array(z.string().min(1)),
  offsetByTranscriptPath: z.record(z.string().min(1), z.number().int().nonnegative()).default({}),
  subagentOffsetByPath: z.record(z.string().min(1), z.number().int().nonnegative()).default({}),
});

export type TraceCheckpoint = z.infer<typeof TraceCheckpoint>;
