import type { Request } from 'express';
import { parseJsonRecord } from '../../core/json-core.ts';

function readCappedBody(
  req: Request,
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

export { declaredContentLength, decodeHeaderText, parseJsonBody, readCappedBody };
