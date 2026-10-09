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

function nonNegativeIntOr(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function coercedNumberOr(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return number;
}

function positiveIntOr(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

export { coercedNumberOr, isRecord, nonNegativeIntOr, numberOr, positiveIntOr, positiveNumberOr, rawTextOr, textOr };
