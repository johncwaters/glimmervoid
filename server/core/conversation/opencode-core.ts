import { z } from 'zod';

import type { TraceRecord } from '../../../shared/contracts/trace.ts';
import { boundedText, boundedToolCallInput } from '../trace-core.ts';
import { textRecords } from './converter-parts.ts';
import type { RecordBase } from './converter-parts.ts';

const FALLBACK_TOOL_NAME = 'tool';

const RelayedEvent = z.object({
  type: z.string(),
  cut: z.literal(true).optional(),
  properties: z.record(z.string(), z.unknown()),
});

const ConversationEventsPayload = z.object({
  session_id: z.string().min(1),
  events: z.array(z.unknown()),
});

const TextPart = z.object({ type: z.string(), text: z.string().optional() }).passthrough();

const InboxEnqueued = z.object({
  inboxID: z.string().optional(),
  item: z.object({ type: z.enum(['user', 'synthetic']), payload: z.object({ text: z.string().default('') }).passthrough() }),
});
const MessagePartEnded = z.object({ assistantMessageID: z.string().min(1), ordinal: z.number().int().default(0), text: z.string() });
const ToolCalled = z.object({ id: z.string().min(1), name: z.string().min(1).default(FALLBACK_TOOL_NAME), input: z.unknown() });
const ToolSucceeded = z.object({
  id: z.string().min(1),
  content: z.array(TextPart).default([]),
  metadata: z.object({ exit: z.number().nullish() }).passthrough().nullish(),
});
const ToolFailed = z.object({ id: z.string().min(1), content: z.array(TextPart).default([]), error: z.unknown() });

type RelayedEvent = z.infer<typeof RelayedEvent>;

function joinedText(parts: readonly z.infer<typeof TextPart>[]): string {
  return parts.map((part) => part.text ?? '').join('');
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return JSON.stringify(error ?? null);
}

function toolResultRecord(base: RecordBase, toolUseId: string, output: string, isError: boolean): TraceRecord {
  const bounded = boundedText(output);
  return { ...base, uuid: `${toolUseId}:result`, kind: 'tool_result', toolUseId, content: bounded.text, isError, truncated: bounded.truncated };
}

function recordsOfEvent(base: RecordBase, event: RelayedEvent): TraceRecord[] {
  switch (event.type) {
    case 'session.inbox.enqueued': {
      const enqueued = InboxEnqueued.safeParse(event.properties);
      if (!enqueued.success) return [];
      const kind = enqueued.data.item.type === 'user' ? 'prompt' : 'expansion';
      return textRecords({ ...base, uuid: enqueued.data.inboxID ?? null }, kind, enqueued.data.item.payload.text);
    }
    case 'session.reasoning.ended':
    case 'session.text.ended': {
      const part = MessagePartEnded.safeParse(event.properties);
      if (!part.success) return [];
      const isReasoning = event.type === 'session.reasoning.ended';
      const uuid = `${part.data.assistantMessageID}:${isReasoning ? 'reasoning' : 'text'}:${part.data.ordinal}`;
      return textRecords({ ...base, uuid, parentUuid: part.data.assistantMessageID }, isReasoning ? 'thinking' : 'assistant', part.data.text);
    }
    case 'session.tool.called': {
      const toolCall = ToolCalled.safeParse(event.properties);
      if (!toolCall.success) return [];
      return [{ ...base, uuid: `${toolCall.data.id}:call`, kind: 'tool_call', toolUseId: toolCall.data.id, name: toolCall.data.name, ...boundedToolCallInput(toolCall.data.input ?? {}) }];
    }
    case 'session.tool.success': {
      const success = ToolSucceeded.safeParse(event.properties);
      if (!success.success) return [];
      const exitCode = success.data.metadata?.exit;
      return [toolResultRecord(base, success.data.id, joinedText(success.data.content), typeof exitCode === 'number' && exitCode !== 0)];
    }
    case 'session.tool.failed': {
      const failure = ToolFailed.safeParse(event.properties);
      if (!failure.success) return [];
      const output = failure.data.error == null ? joinedText(failure.data.content) : errorText(failure.data.error);
      return [toolResultRecord(base, failure.data.id, output, true)];
    }
    default:
      return [];
  }
}

function markedCut(records: TraceRecord[], isCut: boolean): TraceRecord[] {
  if (!isCut) return records;
  return records.map((record) => ({ ...record, truncated: true }));
}

function opencodeRecordsFromPayload(payload: unknown, now: number): TraceRecord[] {
  const relayed = ConversationEventsPayload.safeParse(payload);
  if (!relayed.success) return [];
  const vendorSessionId = relayed.data.session_id;
  return relayed.data.events.flatMap((rawEvent) => {
    const event = RelayedEvent.safeParse(rawEvent);
    if (!event.success) return [];
    const base: RecordBase = { ts: now, uuid: null, parentUuid: null, vendorSessionId };
    return markedCut(recordsOfEvent(base, event.data), event.data.cut === true);
  });
}

export { opencodeRecordsFromPayload };
