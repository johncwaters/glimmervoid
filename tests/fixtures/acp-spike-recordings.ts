import fs from 'node:fs';
import path from 'node:path';
import type { CreateElicitationRequest, RequestPermissionRequest, SessionUpdate, StopReason } from '@agentclientprotocol/sdk';
import { permissionFieldsOf, questionFieldsOf } from '../../session/core/acp-driver-core.ts';
import type { DriverEvent } from '../../session/drivers/driver.ts';

const RECORDINGS_ROOT = path.join(import.meta.dirname, '..', '..', 'harness', 'acp-spike', 'recordings');

interface RecordedWireLine {
  elapsedMs: number;
  direction: string;
  message?: {
    id?: unknown;
    method?: string;
    params?: unknown;
    result?: Record<string, unknown>;
  };
}

interface ReplayEvent {
  ts: number;
  event: DriverEvent;
}

function listAcpSpikeRecordings(agentName: string): string[] {
  return fs.readdirSync(path.join(RECORDINGS_ROOT, agentName))
    .filter((fileName) => fileName.endsWith('.jsonl'))
    .sort();
}

function readAcpSpikeRecording(agentName: string, scenarioFile: string, baseTs: number): ReplayEvent[] {
  const filePath = path.join(RECORDINGS_ROOT, agentName, scenarioFile);
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  const promptRequestIds = new Set<unknown>();
  const events: ReplayEvent[] = [];
  for (const rawLine of lines) {
    const entry = JSON.parse(rawLine) as RecordedWireLine;
    const ts = baseTs + entry.elapsedMs;
    if (entry.direction === 'client->agent' && entry.message?.method === 'session/prompt') {
      promptRequestIds.add(entry.message.id);
      continue;
    }
    if (entry.direction !== 'agent->client') continue;
    if (entry.message?.method === 'session/update' && entry.message.params && typeof entry.message.params === 'object') {
      const params = entry.message.params as Record<string, unknown>;
      const sessionId = String(params.sessionId ?? '');
      const update = params.update as SessionUpdate;
      events.push({ ts, event: { kind: 'update', agentSessionId: sessionId, update } });
      continue;
    }
    if (entry.message?.method === 'session/request_permission' && entry.message.params) {
      const params = entry.message.params as RequestPermissionRequest;
      events.push({
        ts,
        event: {
          kind: 'permission',
          request: { ...permissionFieldsOf(params), options: params.options, withdrawn: new AbortController().signal, respond: () => {} },
        },
      });
      continue;
    }
    if (entry.message?.method === 'elicitation/create' && entry.message.params) {
      const fields = questionFieldsOf(entry.message.params as CreateElicitationRequest);
      if (fields !== null) {
        events.push({ ts, event: { kind: 'question', question: { ...fields, withdrawn: new AbortController().signal, respond: () => {} } } });
      }
      continue;
    }
    if (entry.message?.id !== undefined && promptRequestIds.has(entry.message.id) && entry.message.result) {
      const stopReason = String(entry.message.result.stopReason ?? 'end_turn') as StopReason;
      events.push({ ts, event: { kind: 'turn-end', stopReason } });
    }
  }
  const lastTs = events.at(-1)?.ts ?? baseTs;
  events.push({ ts: lastTs + 1, event: { kind: 'exit', exitCode: 0, signal: undefined } });
  return events;
}

export { listAcpSpikeRecordings, readAcpSpikeRecording };
export type { ReplayEvent };
