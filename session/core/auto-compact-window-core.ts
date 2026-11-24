import { isRecord, positiveNumberOr } from "../../shared/coerce.ts";
import { CONTEXT_WINDOW_SUFFIX } from "../../shared/agent-models-core.ts";

interface AutoCompactSources {
  envWindow: string | undefined;
  settingsByPrecedence: readonly unknown[];
  modelId: string | null;
}

const MIN_WINDOW_TOKENS = 100_000;
const SUFFIX_MULTIPLIERS: Readonly<Record<string, number>> = { k: 1_000, m: 1_000_000 };

function envWindowOf(envWindow: string | undefined): number | null {
  if (envWindow === undefined) return null;
  const trimmed = envWindow.trim();
  const multiplier = SUFFIX_MULTIPLIERS[trimmed.slice(-1).toLowerCase()];
  const tokens = multiplier === undefined ? Number(trimmed) : Number.parseFloat(trimmed) * multiplier;
  if (!Number.isSafeInteger(Math.round(tokens)) || tokens < 1) return null;
  return Math.max(MIN_WINDOW_TOKENS, Math.round(tokens));
}

function settingsTokensOf(window: unknown): number | null {
  const tokens = positiveNumberOr(window, null);
  if (tokens === null || tokens < MIN_WINDOW_TOKENS) return null;
  return tokens;
}

function modelKeysOf(modelId: string | null): string[] {
  if (modelId === null) return [];
  return [modelId, modelId.replace(CONTEXT_WINDOW_SUFFIX, "")];
}

function settingsWindowOf(settings: unknown, modelKeys: readonly string[]): unknown {
  if (!isRecord(settings)) return undefined;
  const settingsByModel = isRecord(settings.modelSettings) ? settings.modelSettings : {};
  const modelSettings = modelKeys.map((key) => settingsByModel[key]).find(isRecord);
  return modelSettings?.autoCompactWindow ?? settings.autoCompactWindow;
}

function configuredAutoCompactWindow({ envWindow, settingsByPrecedence, modelId }: AutoCompactSources): number | null {
  const fromEnv = envWindowOf(envWindow);
  if (fromEnv !== null) return fromEnv;
  const modelKeys = modelKeysOf(modelId);
  for (const settings of settingsByPrecedence) {
    const window = settingsWindowOf(settings, modelKeys);
    if (window !== undefined) return settingsTokensOf(window);
  }
  return null;
}

export { configuredAutoCompactWindow };
