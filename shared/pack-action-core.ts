import { z } from 'zod';
import { ClientMessage } from './contracts/control-messages.ts';
import { PanelActionRequest } from './contracts/pack-bridge.ts';
import type { PackPanelAct } from './contracts/pack-bridge.ts';
import { REVIEW_ACTION_TYPES } from './contracts/reviews.ts';

type PanelActionDecision = { ok: true; type: string; payload: Record<string, unknown> } | { ok: false; error: string };

const PANEL_ACTION_REQUEST_ID = 'panel-action';
export const PANEL_ACTION_MAX_BYTES = 512 * 1024;
const ACTION_TARGET_FIELDS = ['key', 'prKey', 'repo', 'number', 'action', 'actionId', 'itemKey', 'fingerprint'];
const LOG_TEXT_MAX_CHARS = 900;

function declaredFieldsOf(type: string): ReadonlySet<string> {
  const variant = ClientMessage.options.find((candidate) => candidate.shape.type.value === type);
  return new Set(Object.keys(variant?.shape ?? {}).filter((field) => field !== 'type' && field !== 'requestId'));
}

function issueText(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.map(String).join('.') || 'request'}: ${issue.message}`).join('; ');
}

export function panelActionDecision(acts: readonly PackPanelAct[], request: unknown): PanelActionDecision {
  const envelope = PanelActionRequest.safeParse(request);
  if (!envelope.success) return { ok: false, error: `not sent: ${issueText(envelope.error.issues)}` };
  if (!acts.includes('reviews')) return { ok: false, error: `${envelope.data.type} not sent: this panel does not list reviews under acts in pack.json` };
  const message = ClientMessage.safeParse({ ...envelope.data, requestId: PANEL_ACTION_REQUEST_ID });
  if (!message.success) return { ok: false, error: `${envelope.data.type} not sent: ${issueText(message.error.issues)}` };
  const declaredFields = declaredFieldsOf(message.data.type);
  const payload = Object.fromEntries(Object.entries(message.data).filter(([field]) => declaredFields.has(field)));
  const byteCount = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (byteCount > PANEL_ACTION_MAX_BYTES) return { ok: false, error: `${message.data.type} not sent: the request is ${byteCount} bytes, over the ${PANEL_ACTION_MAX_BYTES} byte limit` };
  return { ok: true, type: message.data.type, payload };
}

export function panelActionLogText(viewId: string, type: string, payload: Readonly<Record<string, unknown>>): string {
  const targetText = ACTION_TARGET_FIELDS.flatMap((field) => {
    const value = payload[field];
    return typeof value === 'string' || typeof value === 'number' ? [`${field}=${value}`] : [];
  }).join(' ');
  return `${viewId} sent ${type} ${targetText}`.trim().slice(0, LOG_TEXT_MAX_CHARS);
}

function withoutRequestId(schema: z.core.JSONSchema.BaseSchema): z.core.JSONSchema.BaseSchema {
  return { ...schema, properties: Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([field]) => field !== 'requestId')) };
}

export function panelActionsJsonSchemaText(): string {
  const reviewActionTypes: readonly string[] = REVIEW_ACTION_TYPES;
  const schemaByType = Object.fromEntries(ClientMessage.options
    .filter((variant) => reviewActionTypes.includes(variant.shape.type.value))
    .map((variant) => [variant.shape.type.value, withoutRequestId(z.toJSONSchema(variant, { io: 'input', unrepresentable: 'any' }))]));
  return `${JSON.stringify(schemaByType, null, 2)}\n`;
}
