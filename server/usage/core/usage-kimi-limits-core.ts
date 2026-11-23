import { z } from 'zod';

import { kimiLoginSource } from '../../../shared/kimi-login-core.ts';
import { rateLimitWindow } from './usage-statusline-core.ts';
import type { RateLimitWindow, RateLimitWindows } from './usage-statusline-core.ts';

const TOKEN_EXPIRY_MARGIN_SECONDS = 30;
const PERCENT_PER_RATIO = 100;

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

function kimiUsagesSource(configText: string | null, env: Record<string, string | undefined>): KimiUsagesSource | null {
  if (configText === null) return null;
  const login = kimiLoginSource(configText, env);
  if ('refusal' in login) return null;
  if (!URL.canParse(login.baseUrl) || new URL(login.baseUrl).protocol !== 'https:') return null;
  return { credentialsName: login.credentialsName, usagesUrl: `${login.baseUrl.replace(/\/+$/, '')}/usages` };
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
