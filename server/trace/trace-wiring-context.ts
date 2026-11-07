import fs from 'node:fs';
import os from 'node:os';
import type { EventEmitter } from 'node:events';

import type { TraceRecord } from '../../shared/contracts/trace.ts';
import { claudeProjectsDir } from '../../session/core/conversation-history.ts';
import type { TailState } from '../core/transcript-tail-core.ts';
import type { JsonStateWriter } from '../json-file.ts';
import type { LaneLog } from '../lanes/lane-log.ts';

const MAX_REMEMBERED_FILE_REFUSALS = 64;
const MAX_REMEMBERED_CLOSED_SESSIONS = 512;
const TRACE_SUFFIX = '.jsonl';
const CHECKPOINT_SUFFIX = '.checkpoint.json';

interface TraceBinding {
  glimmervoidSessionId: string;
  vendorSessionId: string;
  vendor: string;
  transcriptPath: string;
  requestedTranscriptPath: string;
  tailState: TailState;
  subagentPathsWithoutOffset: Set<string>;
  subagentOffsetByPath: Record<string, number>;
  notedFileRefusals: Set<string>;
  committedOffsetByTranscriptPath: Record<string, number>;
  checkpointWriter: JsonStateWriter;
  bindingBeforeFirstOpen: TraceBinding | null;
  isSkippingOversizedLine: boolean;
  hasOpenedTranscript: boolean;
  hasWarnedUnreadable: boolean;
  isClosing: boolean;
}

interface TraceResumeState {
  offset: number;
  didReset: boolean;
  didFallbackToTranscriptEnd: boolean;
  scannedBytes: number;
  committedOffsetByTranscriptPath: Record<string, number>;
  subagentPathsWithoutOffset: string[];
  subagentOffsetByPath: Record<string, number>;
}

interface LineContext {
  agentId?: string;
  agentType?: string;
}

interface TraceWiringContext {
  traceDirectory: string;
  emitter: EventEmitter;
  laneLog: LaneLog;
  nowFn: () => number;
  deliveredSecretValuesBySessionId: Map<string, () => readonly string[]>;
  maxRememberedSubagents: number;
  bindingByGlimmervoidSessionId: Map<string, TraceBinding>;
  awaitingTranscriptByGlimmervoidSessionId: Map<string, Record<string, unknown>>;
  pendingRecordsBySessionId: Map<string, TraceRecord[]>;
  closedSessionIds: Set<string>;
  chain(step: () => Promise<void>, failure: string): void;
  isStopped(): boolean;
}

function trimOldest(entries: Set<string>, limit: number): void {
  while (entries.size > limit) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) return;
    entries.delete(oldest);
  }
}

function projectsRoot(): string {
  return claudeProjectsDir(process.env, os.homedir());
}

async function realProjectsRoot(): Promise<string | null> {
  try {
    return await fs.promises.realpath(projectsRoot());
  } catch {
    return null;
  }
}

export {
  CHECKPOINT_SUFFIX,
  MAX_REMEMBERED_CLOSED_SESSIONS,
  MAX_REMEMBERED_FILE_REFUSALS,
  TRACE_SUFFIX,
  projectsRoot,
  realProjectsRoot,
  trimOldest,
};
export type { LineContext, TraceBinding, TraceResumeState, TraceWiringContext };
