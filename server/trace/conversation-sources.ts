import os from 'node:os';
import path from 'node:path';

import type { TraceRecord } from '../../shared/contracts/trace.ts';
import type { CatalogAgentId } from '../../shared/contracts/agent-models.ts';
import { claudeProjectsDir } from '../../session/core/conversation-history.ts';
import { traceRecordsFromTranscriptLine } from '../core/trace-core.ts';
import { codexRecordsFromLine } from '../core/conversation/codex-core.ts';
import { codexRolloutRoots } from '../../session/adapters/codex.ts';
import { isPathInside } from '../../shared/paths.ts';

type TranscriptLineContext = Parameters<typeof traceRecordsFromTranscriptLine>[1];

interface TranscriptConversationSource {
  kind: 'transcript';
  containmentRoots(agentEnv: Record<string, string | undefined>): string[];
  recordsFromLine(rawLine: string, context: TranscriptLineContext): TraceRecord[];
}

type ConversationSource =
  | TranscriptConversationSource
  | { kind: 'relay' }
  | { kind: 'none'; reason: string };

const CONVERTER_NOT_BUILT = 'conversation converter not built yet';

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
  kimi: { kind: 'none', reason: CONVERTER_NOT_BUILT },
  opencode: { kind: 'none', reason: CONVERTER_NOT_BUILT },
  pi: { kind: 'none', reason: CONVERTER_NOT_BUILT },
  antigravity: { kind: 'none', reason: CONVERTER_NOT_BUILT },
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

function containmentRootFor(source: TranscriptConversationSource, agentEnv: Record<string, string | undefined>, candidatePath: string): string {
  const roots = source.containmentRoots(agentEnv);
  return roots.find((root) => isPathInside(path.resolve(root), candidatePath, { allowEqual: false })) ?? roots[0];
}

export { containmentRootFor, transcriptSourceOf };
export type { TranscriptConversationSource };
