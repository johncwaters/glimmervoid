function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOr<Fallback>(value: unknown, fallback: Fallback): string | Fallback {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function rawTextOr<Fallback>(value: unknown, fallback: Fallback): string | Fallback {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function numberOr<Fallback>(value: unknown, fallback: Fallback): number | Fallback {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function positiveNumberOr<Fallback>(value: unknown, fallback: Fallback): number | Fallback {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function coercedNumberOr(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return number;
}

function toCount(value: unknown, fallback = 0): number {
  const count = Number(value);
  if (Number.isFinite(count)) return count;
  return fallback;
}

function parseJsonOrNull(text: unknown): unknown {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export { coercedNumberOr, isRecord, numberOr, parseJsonOrNull, positiveNumberOr, rawTextOr, textOr, toCount };
