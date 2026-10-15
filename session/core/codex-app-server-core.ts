import { z } from 'zod';
import { TraceRecord } from '../../shared/contracts/trace.ts';
import { CONVERSATION_APPROVAL_SUMMARY_MAX_CHARS } from '../../shared/contracts/session.ts';

const itemBase = z.object({ id: z.string().min(1) });
const executionStatus = z.enum(['inProgress', 'completed', 'failed', 'declined']);
const fileChange = z.object({
  path: z.string(),
  kind: z.discriminatedUnion('type', [
    z.object({ type: z.literal('add') }).passthrough(),
    z.object({ type: z.literal('delete') }).passthrough(),
    z.object({ type: z.literal('update'), move_path: z.string().nullable().optional() }).passthrough(),
  ]),
  diff: z.string(),
}).passthrough();
const textPart = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const threadItem = z.discriminatedUnion('type', [
  itemBase.extend({ type: z.literal('userMessage'), content: z.array(z.unknown()) }).passthrough(),
  itemBase.extend({ type: z.literal('agentMessage'), text: z.string() }).passthrough(),
  itemBase.extend({ type: z.literal('reasoning'), summary: z.array(z.string()), content: z.array(z.string()) }).passthrough(),
  itemBase.extend({
    type: z.literal('commandExecution'), command: z.string(), cwd: z.string(), status: executionStatus,
    aggregatedOutput: z.string().nullish(), exitCode: z.number().int().nullish(),
  }).passthrough(),
  itemBase.extend({ type: z.literal('fileChange'), changes: z.array(fileChange), status: executionStatus }).passthrough(),
  itemBase.extend({
    type: z.literal('mcpToolCall'), server: z.string().min(1), tool: z.string().min(1),
    arguments: z.unknown(), status: executionStatus,
    result: z.object({ content: z.array(z.unknown()) }).passthrough().nullish(),
    error: z.object({ message: z.string() }).passthrough().nullish(),
  }).passthrough(),
  itemBase.extend({
    type: z.literal('dynamicToolCall'), tool: z.string().min(1), namespace: z.string().nullish(),
    arguments: z.unknown(), status: executionStatus, success: z.boolean().nullish(),
    contentItems: z.array(z.unknown()).nullish(),
  }).passthrough(),
  itemBase.extend({ type: z.literal('webSearch'), query: z.string(), action: z.record(z.string(), z.unknown()).nullable() }).passthrough(),
  itemBase.extend({
    type: z.literal('collabAgentToolCall'), tool: z.string().min(1), status: executionStatus,
    prompt: z.string().nullable(), receiverThreadIds: z.array(z.string()),
  }).passthrough(),
  itemBase.extend({ type: z.literal('imageView'), path: z.string() }).passthrough(),
  itemBase.extend({ type: z.literal('sleep'), durationMs: z.number().nonnegative() }).passthrough(),
]);

export interface CodexPendingApproval {
  requestId: number | string;
  kind: 'command' | 'fileChange' | 'permissions';
  summary: string;
  isSummaryTruncated: boolean;
  threadId: string;
}

interface CodexItemEvent {
  phase: 'started' | 'completed';
  item: unknown;
  threadId: string;
  turnId: string | null;
  nowMs: number;
  alreadyStartedItemIds: ReadonlySet<string>;
}

export function parseListenUrl(outputLine: string): string | null {
  const matchedUrl = /^\s*listening on:\s*(ws:\/\/127\.0\.0\.1:(\d{1,5}))\s*$/.exec(outputLine);
  if (!matchedUrl) return null;
  const port = Number(matchedUrl[2]);
  if (port < 1 || port > 65535) return null;
  return matchedUrl[1] ?? null;
}

function textFromParts(parts: unknown[], type: string): string {
  const texts: string[] = [];
  for (const part of parts) {
    const parsedPart = z.object({ type: z.literal(type), text: z.string() }).passthrough().safeParse(part);
    if (parsedPart.success) texts.push(parsedPart.data.text);
  }
  return texts.join('\n');
}

export function traceRecordsForItemEvent(event: CodexItemEvent): { records: TraceRecord[]; startedItemIds: string[] } {
  const parsedItem = threadItem.safeParse(event.item);
  if (!parsedItem.success) return { records: [], startedItemIds: [] };
  const item = parsedItem.data;
  const base = { ts: event.nowMs, uuid: item.id, parentUuid: event.turnId, vendorSessionId: event.threadId };
  const records: TraceRecord[] = [];
  const startedItemIds: string[] = [];
  const hasStarted = event.alreadyStartedItemIds.has(item.id);
  const appendRecord = (candidate: unknown): boolean => {
    const parsedRecord = TraceRecord.safeParse(candidate);
    if (!parsedRecord.success) return false;
    records.push(parsedRecord.data);
    return true;
  };
  const appendText = (kind: 'prompt' | 'assistant' | 'thinking', text: string) => {
    if (hasStarted) return;
    if (appendRecord({ ...base, kind, text })) startedItemIds.push(item.id);
  };
  if (item.type === 'userMessage') {
    const text = item.content.flatMap((part) => {
      const parsedPart = textPart.safeParse(part);
      return parsedPart.success ? [parsedPart.data.text] : [];
    }).join('\n');
    appendText('prompt', text);
    return { records, startedItemIds };
  }
  if (item.type === 'agentMessage') {
    if (event.phase === 'completed') appendText('assistant', item.text);
    return { records, startedItemIds };
  }
  if (item.type === 'reasoning') {
    const text = [...item.summary, ...item.content].join('\n');
    if (event.phase === 'completed' && text.trim()) appendText('thinking', text);
    return { records, startedItemIds };
  }
  let name: string;
  let input: unknown;
  let content = '';
  let isError = false;
  switch (item.type) {
    case 'commandExecution':
      name = 'Bash';
      input = { command: item.command, cwd: item.cwd };
      content = item.aggregatedOutput ?? '';
      isError = item.status === 'failed' || item.status === 'declined' || (item.exitCode != null && item.exitCode !== 0);
      break;
    case 'fileChange':
      name = 'Edit';
      input = { changes: item.changes.map(({ path, kind }) => ({ path, kind })) };
      content = item.changes.map((change) => change.diff).join('\n');
      isError = item.status === 'failed' || item.status === 'declined';
      break;
    case 'mcpToolCall':
      name = `mcp:${item.server}/${item.tool}`;
      input = item.arguments;
      content = item.error?.message ?? textFromParts(item.result?.content ?? [], 'text');
      isError = item.status === 'failed' || item.error != null;
      break;
    case 'dynamicToolCall':
      name = item.namespace ? `${item.namespace}/${item.tool}` : item.tool;
      input = item.arguments;
      content = textFromParts(item.contentItems ?? [], 'inputText');
      isError = item.status === 'failed' || item.success === false;
      break;
    case 'webSearch':
      name = 'WebSearch';
      input = { query: item.query, action: item.action };
      content = item.query;
      break;
    case 'collabAgentToolCall':
      name = item.tool;
      input = { prompt: item.prompt, receiverThreadIds: item.receiverThreadIds };
      content = item.status;
      isError = item.status === 'failed';
      break;
    case 'imageView':
      name = 'ViewImage';
      input = { path: item.path };
      content = item.path;
      break;
    case 'sleep':
      name = 'Sleep';
      input = { durationMs: item.durationMs };
      content = `${item.durationMs} ms`;
      break;
  }
  if (!hasStarted && appendRecord({ ...base, kind: 'tool_call', toolUseId: item.id, name, input })) {
    startedItemIds.push(item.id);
  }
  if (event.phase === 'completed') {
    const contentLimit = item.type === 'commandExecution' || item.type === 'fileChange' ? 65536 : 4000;
    appendRecord({ ...base, kind: 'tool_result', toolUseId: item.id, content: content.slice(0, contentLimit), isError, truncated: content.length > contentLimit });
  }
  return { records, startedItemIds };
}

const requestedPermissionScope = z.object({
  network: z.object({ enabled: z.boolean().nullable() }).strict().nullable(),
  fileSystem: z.record(z.string(), z.union([z.string(), z.array(z.string())]).nullable()).nullable(),
}).passthrough();

const approvalParams = z.object({
  threadId: z.string().min(1),
  command: z.string().nullish(),
  reason: z.string().nullish(),
  grantRoot: z.string().nullish(),
  changes: z.array(z.object({ path: z.string() }).passthrough()).optional(),
  permissions: z.unknown().optional(),
}).passthrough();

interface ApprovalDescription {
  summary: string;
  isScopeUnrenderable: boolean;
}

function describeFileChangeApproval(approval: z.infer<typeof approvalParams>): ApprovalDescription {
  const changedPaths = approval.changes?.map((change) => change.path).join(', ');
  const grantedScope = approval.grantRoot ? `Write access to ${approval.grantRoot}` : '';
  const summaryParts = [grantedScope, changedPaths || approval.reason || ''].filter((part) => part.length > 0);
  return { summary: summaryParts.join('. ') || 'File change approval', isScopeUnrenderable: false };
}

function describePermissionsApproval(approval: z.infer<typeof approvalParams>): ApprovalDescription {
  const reason = approval.reason ?? 'Permissions approval';
  const parsedScope = requestedPermissionScope.safeParse(approval.permissions);
  if (!parsedScope.success) return { summary: reason, isScopeUnrenderable: true };
  const { network, fileSystem } = parsedScope.data;
  const scopeParts: string[] = [];
  if (network?.enabled === true) scopeParts.push('Network access');
  for (const [accessKind, paths] of Object.entries(fileSystem ?? {})) {
    if (paths === null) continue;
    const pathList = typeof paths === 'string' ? paths : paths.join(', ');
    if (pathList.length > 0) scopeParts.push(`File system ${accessKind}: ${pathList}`);
  }
  return { summary: [...scopeParts, reason].join('. '), isScopeUnrenderable: false };
}

function describeApproval(method: string, approval: z.infer<typeof approvalParams>): (ApprovalDescription & { kind: CodexPendingApproval['kind'] }) | null {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return { kind: 'command', summary: approval.command ?? approval.reason ?? 'Command approval', isScopeUnrenderable: false };
    case 'item/fileChange/requestApproval':
      return { kind: 'fileChange', ...describeFileChangeApproval(approval) };
    case 'item/permissions/requestApproval':
      return { kind: 'permissions', ...describePermissionsApproval(approval) };
    default:
      return null;
  }
}

export function pendingApprovalFromServerRequest(method: string, params: unknown, requestId: number | string): CodexPendingApproval | null {
  const parsedParams = approvalParams.safeParse(params);
  if (!parsedParams.success) return null;
  const approval = parsedParams.data;
  const description = describeApproval(method, approval);
  if (!description) return null;
  const fullSummary = description.summary.trim();
  return {
    requestId,
    kind: description.kind,
    summary: fullSummary.slice(0, CONVERSATION_APPROVAL_SUMMARY_MAX_CHARS),
    isSummaryTruncated: description.isScopeUnrenderable || fullSummary.length > CONVERSATION_APPROVAL_SUMMARY_MAX_CHARS,
    threadId: approval.threadId,
  };
}

export function isFollowableThread(thread: unknown): boolean {
  return z.object({ id: z.string().trim().min(1), environments: z.array(z.unknown()).min(1) }).passthrough().safeParse(thread).success;
}

export function isNoRolloutError(error: unknown): boolean {
  if (typeof error === 'string') return /no rollout found/i.test(error);
  if (error instanceof Error) return /no rollout found/i.test(error.message);
  const parsedError = z.object({ message: z.string() }).passthrough().safeParse(error);
  return parsedError.success && /no rollout found/i.test(parsedError.data.message);
}
