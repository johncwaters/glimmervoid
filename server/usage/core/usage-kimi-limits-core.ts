import { z } from 'zod';

import { rateLimitWindow } from './usage-statusline-core.ts';
import type { RateLimitWindow, RateLimitWindows } from './usage-statusline-core.ts';

const KIMI_PROVIDER_TABLE = '[providers."managed:kimi-code"]';
const KIMI_PROVIDER_OAUTH_TABLE = '[providers."managed:kimi-code".oauth]';
const KIMI_DEFAULT_BASE_URL = 'https://api.kimi.com/coding/v1';
const KIMI_FILE_STORAGE = 'file';
const KIMI_OAUTH_KEY_PREFIX = 'oauth/';
const TOKEN_EXPIRY_MARGIN_SECONDS = 30;
const PERCENT_PER_RATIO = 100;

const TOML_TRAILING_COMMENT = /\s*#[^"']*$/;
const TOML_STRING_ASSIGNMENT = /^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"\\]*)"\s*(?:#.*)?$/;

const StoredKimiToken = z.object({
  access_token: z.string().min(1),
  expires_at: z.number().nullable().optional(),
});

const KimiQuotaEntry = z.object({
  used_ratio: z.union([z.number(), z.string()]),
  reset_time: z.string().optional(),
});

const KimiUsagesBody = z.object({
  usages: z.object({
    limit_5h: KimiQuotaEntry.optional(),
    limit_7d: KimiQuotaEntry.optional(),
  }),
});

interface KimiUsagesSource {
  credentialsName: string;
  usagesUrl: string;
}

interface KimiPlanLimitsSnapshot {
  rateLimits: RateLimitWindows;
  ts: number;
}

function providerStringsByTable(configText: string): Map<string, Map<string, string>> {
  const stringsByTable = new Map<string, Map<string, string>>();
  let currentTable = '';
  for (const line of configText.split(/\r?\n/)) {
    if (line.trimStart().startsWith('[')) {
      currentTable = line.replace(TOML_TRAILING_COMMENT, '').replaceAll(/\s+/g, '');
      continue;
    }
    const assignment = TOML_STRING_ASSIGNMENT.exec(line);
    if (!assignment) continue;
    const tableStrings = stringsByTable.get(currentTable) ?? new Map<string, string>();
    tableStrings.set(assignment[1], assignment[2]);
    stringsByTable.set(currentTable, tableStrings);
  }
  return stringsByTable;
}

function tokenStorageName(oauthKey: string): string | null {
  const name = oauthKey.startsWith(KIMI_OAUTH_KEY_PREFIX) ? oauthKey.slice(KIMI_OAUTH_KEY_PREFIX.length) : oauthKey;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return null;
  return name;
}

function kimiUsagesSource(configText: string | null, env: Record<string, string | undefined>): KimiUsagesSource | null {
  if (configText === null) return null;
  const stringsByTable = providerStringsByTable(configText);
  const oauth = stringsByTable.get(KIMI_PROVIDER_OAUTH_TABLE);
  const oauthKey = oauth?.get('key');
  if (!oauth || !oauthKey) return null;
  if ((oauth.get('storage') ?? KIMI_FILE_STORAGE) !== KIMI_FILE_STORAGE) return null;
  const credentialsName = tokenStorageName(oauthKey);
  if (credentialsName === null) return null;
  const baseUrl = stringsByTable.get(KIMI_PROVIDER_TABLE)?.get('base_url') ?? env.KIMI_CODE_BASE_URL ?? KIMI_DEFAULT_BASE_URL;
  if (!URL.canParse(baseUrl) || new URL(baseUrl).protocol !== 'https:') return null;
  return { credentialsName, usagesUrl: `${baseUrl.replace(/\/+$/, '')}/usages` };
}

function pickKimiAccessToken(credentialsText: string, nowMs: number): string | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(credentialsText);
  } catch {
    return null;
  }
  const stored = StoredKimiToken.safeParse(decoded);
  if (!stored.success) return null;
  const expiresAtSeconds = stored.data.expires_at;
  if (typeof expiresAtSeconds === 'number' && nowMs / 1000 >= expiresAtSeconds - TOKEN_EXPIRY_MARGIN_SECONDS) return null;
  return stored.data.access_token;
}

function quotaWindow(entry: z.infer<typeof KimiQuotaEntry> | undefined): RateLimitWindow | null {
  if (!entry) return null;
  const usedRatio = Number(entry.used_ratio);
  if (!Number.isFinite(usedRatio)) return null;
  const resetsAtMs = entry.reset_time ? Date.parse(entry.reset_time) : null;
  return rateLimitWindow(usedRatio * PERCENT_PER_RATIO, Number.isFinite(resetsAtMs) ? resetsAtMs : null);
}

function parseKimiUsages(body: unknown, nowMs: number): KimiPlanLimitsSnapshot | null {
  const parsed = KimiUsagesBody.safeParse(body);
  if (!parsed.success) return null;
  const fiveHour = quotaWindow(parsed.data.usages.limit_5h);
  const sevenDay = quotaWindow(parsed.data.usages.limit_7d);
  if (!fiveHour && !sevenDay) return null;
  return { rateLimits: { fiveHour, sevenDay }, ts: nowMs };
}

export { kimiUsagesSource, parseKimiUsages, pickKimiAccessToken };
export type { KimiPlanLimitsSnapshot };
