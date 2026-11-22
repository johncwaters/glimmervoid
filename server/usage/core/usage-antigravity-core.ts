import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonLine, vendorUsageEntry } from './usage-entry-core.ts';
import type { DedupIdentityEntry, UsageEntry } from './usage-entry-core.ts';
import { numberOr, rawTextOr } from '../../../shared/coerce.ts';

const ANTIGRAVITY_TRANSCRIPT_FILENAME = 'transcript.jsonl';
const ANTIGRAVITY_TRANSCRIPT_SEGMENTS = Object.freeze(['.system_generated', 'logs', ANTIGRAVITY_TRANSCRIPT_FILENAME] as const);

interface AntigravityTranscriptLine {
  step_index?: unknown;
  source?: unknown;
  type?: unknown;
  created_at?: unknown;
  model?: unknown;
  input_tokens?: unknown;
  cache_read_tokens?: unknown;
  output_tokens?: unknown;
}

interface AntigravityConversationMetadata {
  conversations?: Record<string, {
    summary?: {
      WorkspaceURIs?: unknown;
    } | null;
  } | null> | null;
}

function antigravitySessionIdFromPath(filePath: string): string | null {
  const logsFolder = path.dirname(filePath);
  const generatedFolder = path.dirname(logsFolder);
  if (path.basename(logsFolder) === 'logs' && path.basename(generatedFolder) === '.system_generated') {
    const conversationId = path.basename(path.dirname(generatedFolder));
    return conversationId || null;
  }
  const fallbackFolder = path.basename(logsFolder);
  return fallbackFolder || null;
}

function workspacePathFromUri(rawUri: unknown): string | null {
  const uri = rawTextOr(rawUri, null);
  if (!uri) return null;
  if (!uri.startsWith('file://')) return uri;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function parseAntigravityConversationMetadata(rawJson: string): Map<string, string> {
  const cwdByConversation = new Map<string, string>();
  let parsed: AntigravityConversationMetadata | null = null;
  try {
    parsed = JSON.parse(rawJson) as AntigravityConversationMetadata;
  } catch {
    return cwdByConversation;
  }
  const conversations = parsed?.conversations;
  if (!conversations || typeof conversations !== 'object') return cwdByConversation;
  for (const [conversationId, record] of Object.entries(conversations)) {
    const uris = record?.summary?.WorkspaceURIs;
    if (!Array.isArray(uris) || uris.length === 0) continue;
    const workspacePath = workspacePathFromUri(uris[0]);
    if (workspacePath) cwdByConversation.set(conversationId, workspacePath);
  }
  return cwdByConversation;
}

function parseAntigravityUsageLine(
  line: unknown,
  filePath: string,
  cwdByConversation?: ReadonlyMap<string, string>,
): UsageEntry | null {
  const raw = parseJsonLine(line, '"input_tokens"');
  if (!raw) return null;
  const parsed = raw as AntigravityTranscriptLine;
  if (parsed.source !== 'MODEL' || parsed.type !== 'PLANNER_RESPONSE') return null;
  const model = rawTextOr(parsed.model, null);
  const createdAt = rawTextOr(parsed.created_at, null);
  if (!model || !createdAt) return null;
  const timestampMs = Date.parse(createdAt);
  if (!Number.isFinite(timestampMs)) return null;
  const input = numberOr(parsed.input_tokens, 0);
  const cacheRead = numberOr(parsed.cache_read_tokens, 0);
  const output = numberOr(parsed.output_tokens, 0);
  const sessionId = antigravitySessionIdFromPath(filePath);
  const stepIndex = numberOr(parsed.step_index, null);
  const messageId = stepIndex === null ? null : String(stepIndex);
  const entry = vendorUsageEntry({
    timestampMs,
    sessionId,
    model,
    input,
    output,
    cacheCreate: 0,
    cacheRead,
    costUSD: null,
    vendor: 'antigravity',
    messageId,
  });
  const cwd = sessionId ? cwdByConversation?.get(sessionId) ?? null : null;
  if (!cwd) return entry;
  return { ...entry, cwd };
}

function antigravityDedupIdentity(entry: DedupIdentityEntry | null | undefined): string | null {
  if (!entry) return null;
  if (entry.messageId) return `${entry.vendor}:${entry.sessionId}:${entry.messageId}`;
  return `${entry.vendor}:${entry.sessionId}:${entry.timestampMs}:${entry.model}`;
}

export {
  ANTIGRAVITY_TRANSCRIPT_FILENAME,
  ANTIGRAVITY_TRANSCRIPT_SEGMENTS,
  antigravityDedupIdentity,
  antigravitySessionIdFromPath,
  parseAntigravityConversationMetadata,
  parseAntigravityUsageLine,
};
