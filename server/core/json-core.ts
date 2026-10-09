import { isRecord } from '../../shared/coerce.ts';

function jsonSourceText(text: unknown): string | null {
  if (typeof text === 'string') return text;
  if (Buffer.isBuffer(text)) return text.toString('utf8');
  return null;
}

function parseJsonOrNull(text: unknown): unknown {
  const source = jsonSourceText(text);
  if (source === null) return null;
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

function parseJsonRecord(text: unknown, { admitArrays = false }: { admitArrays?: boolean } = {}): Record<string, unknown> | null {
  const parsed = parseJsonOrNull(text);
  if (admitArrays) return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  return isRecord(parsed) ? parsed : null;
}

export { parseJsonOrNull, parseJsonRecord };
