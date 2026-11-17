import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CONVERSATION_EVENTS_HOOK_EVENT } from '../../shared/contracts/trace.ts';
import type { TraceRecord } from '../../shared/contracts/trace.ts';
import type { CatalogAgentId } from '../../shared/contracts/agent-models.ts';
import { claudeProjectsDir } from '../../session/core/conversation-history.ts';
import { traceRecordsFromTranscriptLine } from '../core/trace-core.ts';
import { codexRecordsFromLine } from '../core/conversation/codex-core.ts';
import { codexRolloutRoots } from '../../session/adapters/codex.ts';
import { kimiRecordsFromLine } from '../core/conversation/kimi-core.ts';
import { kimiSessionRoots, locateKimiWire } from '../../session/adapters/kimi.ts';
import { piRecordsFromLine } from '../core/conversation/pi-core.ts';
import { piSessionRoots } from '../../session/adapters/pi.ts';
import { opencodeRecordsFromPayload } from '../core/conversation/opencode-core.ts';
import { antigravityRecordsFromLine } from '../core/conversation/antigravity-core.ts';
import { isPathInside } from '../../shared/paths.ts';

type TranscriptLineContext = Parameters<typeof traceRecordsFromTranscriptLine>[1];

interface TranscriptConversationSource {
  kind: 'transcript';
  containmentRoots(agentEnv: Record<string, string | undefined>): string[];
  recordsFromLine(rawLine: string, context: TranscriptLineContext): TraceRecord[];
  locateTranscript?(vendorSessionId: string, agentEnv: Record<string, string | undefined>): Promise<string | null>;
}

interface RelayConversationSource {
  kind: 'relay';
  hookEvent: string;
  recordsFromPayload(payload: unknown, now: number): TraceRecord[];
}

type ConversationSource =
  | TranscriptConversationSource
  | RelayConversationSource
  | { kind: 'none'; reason: string };

const ANTIGRAVITY_BRAIN_FOLDERS = ['antigravity-cli', 'antigravity'];
const ANTIGRAVITY_CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANTIGRAVITY_TRANSCRIPT_PATH = ['.system_generated', 'logs', 'transcript_full.jsonl'];

function antigravityBrainRoots(): string[] {
  return ANTIGRAVITY_BRAIN_FOLDERS.map((folder) => path.join(os.homedir(), '.gemini', folder, 'brain'));
}

async function locateAntigravityTranscript(conversationId: string): Promise<string | null> {
  if (!ANTIGRAVITY_CONVERSATION_ID_PATTERN.test(conversationId)) return null;
  for (const brainRoot of antigravityBrainRoots()) {
    const transcriptPath = path.join(brainRoot, conversationId, ...ANTIGRAVITY_TRANSCRIPT_PATH);
    const isTranscriptFile = await fsPromises.stat(transcriptPath).then((stats) => stats.isFile(), () => false);
    if (isTranscriptFile) return transcriptPath;
  }
  return null;
}

const conversationSourceByAgentId = {
  'claude-code': {
    kind: 'transcript',
    containmentRoots: () => [claudeProjectsDir(process.env, os.homedir())],
    recordsFromLine: traceRecordsFromTranscriptLine,
  },
  codex: {
    kind: 'transcript',
    containmentRoots: codexRolloutRoots,
    recordsFromLine: codexRecordsFromLine,
  },
  kimi: {
    kind: 'transcript',
    containmentRoots: kimiSessionRoots,
    recordsFromLine: kimiRecordsFromLine,
    locateTranscript: locateKimiWire,
  },
  opencode: {
    kind: 'relay',
    hookEvent: CONVERSATION_EVENTS_HOOK_EVENT,
    recordsFromPayload: opencodeRecordsFromPayload,
  },
  pi: {
    kind: 'transcript',
    containmentRoots: piSessionRoots,
    recordsFromLine: piRecordsFromLine,
  },
  antigravity: {
    kind: 'transcript',
    containmentRoots: antigravityBrainRoots,
    recordsFromLine: antigravityRecordsFromLine,
    locateTranscript: locateAntigravityTranscript,
  },
} satisfies Record<CatalogAgentId, ConversationSource>;

const BEST_EFFORT_SOURCE: ConversationSource = { kind: 'none', reason: 'best-effort agents keep no conversation' };

function isCatalogAgentId(agentId: string): agentId is CatalogAgentId {
  return Object.hasOwn(conversationSourceByAgentId, agentId);
}

function conversationSourceOf(agentId: string): ConversationSource {
  if (!isCatalogAgentId(agentId)) return BEST_EFFORT_SOURCE;
  return conversationSourceByAgentId[agentId];
}

function transcriptSourceOf(agentId: string): TranscriptConversationSource | null {
  const source = conversationSourceOf(agentId);
  return source.kind === 'transcript' ? source : null;
}

function relaySourceOf(agentId: string): RelayConversationSource | null {
  const source = conversationSourceOf(agentId);
  return source.kind === 'relay' ? source : null;
}

function containmentRootFor(source: TranscriptConversationSource, agentEnv: Record<string, string | undefined>, candidatePath: string): string {
  const roots = source.containmentRoots(agentEnv);
  return roots.find((root) => isPathInside(path.resolve(root), candidatePath, { allowEqual: false })) ?? roots[0];
}

export { containmentRootFor, relaySourceOf, transcriptSourceOf };
export type { TranscriptConversationSource };
