import { z } from 'zod';

import { CONVERSATION_APPROVAL_SUMMARY_MAX_CHARS, ELICITATION_MAX_FIELDS, ElicitationRequest as ElicitationRequestSchema } from '../../shared/contracts/session.ts';
import type { ConversationAnswers, ConversationApproval, ElicitationField, ElicitationRequest } from '../../shared/contracts/session.ts';

type ElicitationAction = 'accept' | 'decline' | 'cancel';
type ElicitationContentValue = string | number | boolean;

type ElicitationHookReply = {
  hookSpecificOutput: { hookEventName: 'Elicitation'; action: ElicitationAction; content?: Record<string, ElicitationContentValue> };
};

const ELICITATION_RELEASING_HOOK_EVENTS: ReadonlySet<string> = new Set(['elicitationresult', 'stop', 'stopfailure', 'sessionend', 'userpromptsubmit']);
const BOOLEAN_TEXT_BY_VALUE: Readonly<Record<string, boolean>> = { true: true, false: false };

const SchemaProperty = z.strictObject({
  type: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
});

const ElicitationPayload = z.object({
  mcp_server_name: z.string().min(1),
  message: z.string().default(''),
  mode: z.enum(['form', 'url']).default('form'),
  url: z.string().url().nullish(),
  requested_schema: z.object({ properties: z.record(z.string(), SchemaProperty).default({}), required: z.array(z.string()).default([]) }).nullish(),
});

const WEB_URL_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

function isWebUrl(url: string): boolean {
  return WEB_URL_PROTOCOLS.has(new URL(url).protocol);
}

const FIELD_TYPE_BY_SCHEMA_TYPE: Readonly<Record<string, ElicitationField['type']>> = { string: 'string', number: 'number', integer: 'integer', boolean: 'boolean' };

function fieldOf(name: string, property: z.infer<typeof SchemaProperty>, requiredNames: readonly string[]): ElicitationField | null {
  const enumOptions = property.enum ?? [];
  const fieldType = enumOptions.length > 0 ? 'enum' : FIELD_TYPE_BY_SCHEMA_TYPE[property.type ?? ''];
  if (fieldType === undefined) return null;
  return { name, title: property.title ?? name, description: property.description ?? '', type: fieldType, options: enumOptions, isRequired: requiredNames.includes(name) };
}

function elicitationRequestOf(payload: unknown): ElicitationRequest | null {
  const parsed = ElicitationPayload.safeParse(payload);
  if (!parsed.success) return null;
  const { mcp_server_name: serverName, message, mode, url, requested_schema: schema } = parsed.data;
  if (mode === 'url') return url && isWebUrl(url) ? withinContract({ serverName, message: message.slice(0, CONVERSATION_APPROVAL_SUMMARY_MAX_CHARS), mode, url, fields: [] }) : null;
  const properties = Object.entries(schema?.properties ?? {});
  if (properties.length === 0 || properties.length > ELICITATION_MAX_FIELDS) return null;
  const fields = properties.map(([name, property]) => fieldOf(name, property, schema?.required ?? []));
  if (fields.some((field) => field === null)) return null;
  return withinContract({ serverName, message: message.slice(0, CONVERSATION_APPROVAL_SUMMARY_MAX_CHARS), mode, url: null, fields: fields.filter((field): field is ElicitationField => field !== null) });
}

function withinContract(request: ElicitationRequest): ElicitationRequest | null {
  const parsed = ElicitationRequestSchema.safeParse(request);
  return parsed.success ? parsed.data : null;
}

function elicitationApprovalOf(request: ElicitationRequest, requestId: string): ConversationApproval {
  return { requestId, kind: 'elicitation', toolName: request.serverName, summary: request.message, isSummaryTruncated: false, elicitation: request };
}

function contentValueOf(field: ElicitationField, text: string): ElicitationContentValue | null {
  if (field.type === 'boolean') return BOOLEAN_TEXT_BY_VALUE[text] ?? null;
  if (field.type === 'enum') return field.options.includes(text) ? text : null;
  if (field.type === 'string') return text;
  const numberValue = Number(text);
  if (!Number.isFinite(numberValue) || (field.type === 'integer' && !Number.isInteger(numberValue))) return null;
  return numberValue;
}

function elicitationContentOf(request: ElicitationRequest, answers: ConversationAnswers): Record<string, ElicitationContentValue> | null {
  const content: Record<string, ElicitationContentValue> = {};
  for (const field of request.fields) {
    const text = Object.hasOwn(answers, field.name) ? (answers[field.name] ?? '').trim() : '';
    if (text.length === 0) {
      if (field.isRequired) return null;
      continue;
    }
    const value = contentValueOf(field, text);
    if (value === null) return null;
    content[field.name] = value;
  }
  return content;
}

function elicitationReply(action: ElicitationAction, content?: Record<string, ElicitationContentValue>): ElicitationHookReply {
  return { hookSpecificOutput: { hookEventName: 'Elicitation', action, ...(content === undefined ? {} : { content }) } };
}

function isElicitationHoldReleasedBy(event: string): boolean {
  return ELICITATION_RELEASING_HOOK_EVENTS.has(event.toLowerCase());
}

export { elicitationApprovalOf, elicitationContentOf, elicitationReply, elicitationRequestOf, isElicitationHoldReleasedBy };
export type { ElicitationHookReply };
