import type { IncomingMessage } from 'node:http';
import type { Request } from 'express';
import { createTopLevelAgentIdScanner } from '../shared/hook-oversize-core.ts';
import { parseJsonRecord } from './core/json-core.ts';

function readCappedBody(
  req: IncomingMessage,
  capBytes: number,
  onOversize: (declaredBytes: string) => void,
  { drainBytes = 0 }: { drainBytes?: number } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let settled = false;
    let isOversize = false;
    const abandon = () => {
      if (settled) return;
      settled = true;
      resolve(null);
    };
    const declaredBytes = () => String(req.headers['content-length'] || `at least ${receivedBytes}`);
    req.on('error', abandon);
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      receivedBytes += chunk.length;
      if (receivedBytes <= capBytes) {
        chunks.push(chunk);
        return;
      }
      isOversize = true;
      chunks.length = 0;
      if (receivedBytes <= capBytes + drainBytes) return;
      onOversize(declaredBytes());
      req.destroy();
      abandon();
    });
    req.on('end', () => {
      if (settled) return;
      if (isOversize) {
        onOversize(declaredBytes());
        abandon();
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function parseJsonBody(body: string): Record<string, unknown> {
  return parseJsonRecord(body, { admitArrays: true }) ?? {};
}

function decodeHeaderText(header: unknown): string | null {
  if (typeof header !== 'string' || header.length === 0) return null;
  try {
    return decodeURIComponent(header);
  } catch {
    return null;
  }
}

function declaredContentLength(req: Request): number | null {
  const declared = Number(req.headers['content-length']);
  return Number.isFinite(declared) && declared >= 0 ? declared : null;
}

type CappedBodyOrDrainResult =
  | { kind: 'ok'; body: string }
  | { kind: 'oversize'; hasTopLevelAgentId: boolean };

function readCappedBodyOrDrainHead(
  req: IncomingMessage,
  capBytes: number,
  drainBytes: number,
): Promise<CappedBodyOrDrainResult | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const agentIdScanner = createTopLevelAgentIdScanner();
    let receivedBytes = 0;
    let state: 'reading' | 'oversize' | 'settled' = 'reading';
    const abandon = () => {
      if (state === 'settled') return;
      state = 'settled';
      resolve(null);
    };
    req.on('error', abandon);
    req.on('data', (chunk: Buffer) => {
      if (state === 'settled') return;
      receivedBytes += chunk.length;
      agentIdScanner.push(chunk);
      if (receivedBytes <= capBytes) {
        chunks.push(chunk);
        return;
      }
      if (state === 'reading') {
        state = 'oversize';
        chunks.length = 0;
      }
      if (receivedBytes <= capBytes + drainBytes) return;
      req.destroy();
      abandon();
    });
    req.on('end', () => {
      if (state === 'settled') return;
      const finalState = state;
      state = 'settled';
      if (finalState === 'oversize') {
        resolve({ kind: 'oversize', hasTopLevelAgentId: agentIdScanner.hasTopLevelAgentId() });
        return;
      }
      resolve({ kind: 'ok', body: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

export { declaredContentLength, decodeHeaderText, parseJsonBody, readCappedBody, readCappedBodyOrDrainHead };
