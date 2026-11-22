import { isRecord } from '../coerce.ts';

export const POSTHOG_WHOLE_NUMBER_ROUNDING: Record<string, (value: number) => number> = {
  maxConcurrentInvestigations: Math.ceil,
  minUsersToInvestigate: Math.ceil,
};

const LEGACY_INTEGER_FIELDS = [
  ...Object.entries(POSTHOG_WHOLE_NUMBER_ROUNDING).map(([key, round]) => ({ path: ['posthog', key], min: 1, round })),
];

function normalizeIntegerField(config: Record<string, unknown>, path: string[], min: number, round: (value: number) => number) {
  let target = config;
  for (const segment of path.slice(0, -1)) {
    const block = target[segment];
    if (!isRecord(block)) return;
    target[segment] = { ...block };
    target = target[segment] as Record<string, unknown>;
  }
  const key = path.at(-1) as string;
  const value = target[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return;
  if (Number.isInteger(value)) return;
  target[key] = Math.min(Number.MAX_SAFE_INTEGER, Math.max(min, round(value)));
}

export function normalizeLegacyConfigNumbers(candidate: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...candidate };
  for (const { path, min, round } of LEGACY_INTEGER_FIELDS) {
    normalizeIntegerField(normalized, path, min, round);
  }
  return normalized;
}
