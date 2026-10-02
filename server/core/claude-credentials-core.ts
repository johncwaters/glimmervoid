import { z } from 'zod';

const LOGIN_REFRESH_MARGIN_MS = 10 * 60 * 1000;

const StoredClaudeCredentials = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    expiresAt: z.number().int().positive(),
  }),
});

interface LoginAccessToken {
  accessToken: string;
  expiresAt: number;
}

type ArmTokenDecision =
  | { kind: 'use'; token: string }
  | { kind: 'refresh' }
  | { kind: 'unavailable'; reason: string };

function parseStoredCredentials(text: string): LoginAccessToken | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = StoredClaudeCredentials.safeParse(decoded);
  if (!parsed.success) return null;
  return { accessToken: parsed.data.claudeAiOauth.accessToken, expiresAt: parsed.data.claudeAiOauth.expiresAt };
}

function requiredValidUntil(nowMs: number, cellTimeoutSeconds: number): number {
  return nowMs + cellTimeoutSeconds * 1000 + LOGIN_REFRESH_MARGIN_MS;
}

function exhaustedLoginReason(login: LoginAccessToken, nowMs: number, cellTimeoutSeconds: number, expiresAtBeforeRefresh: number | null): string {
  const minutesLeft = Math.max(0, Math.floor((login.expiresAt - nowMs) / 60000));
  const hasRefreshExtended = expiresAtBeforeRefresh !== null && login.expiresAt > expiresAtBeforeRefresh;
  const refreshOutcome = hasRefreshExtended
    ? `a refresh extended it to ${minutesLeft} minutes, still too soon for a ${cellTimeoutSeconds}s cell`
    : `too soon for a ${cellTimeoutSeconds}s cell, and a refresh did not extend it`;
  return `the Claude Code login token expires in ${minutesLeft} minutes; ${refreshOutcome}; for long cells set GLIMMERVOID_CLAUDE_OAUTH_TOKEN from claude setup-token`;
}

function decideArmToken({ login, nowMs, cellTimeoutSeconds, hasRefreshed, expiresAtBeforeRefresh = null }: {
  login: LoginAccessToken | null;
  nowMs: number;
  cellTimeoutSeconds: number;
  hasRefreshed: boolean;
  expiresAtBeforeRefresh?: number | null;
}): ArmTokenDecision {
  if (login && login.expiresAt >= requiredValidUntil(nowMs, cellTimeoutSeconds)) return { kind: 'use', token: login.accessToken };
  if (!hasRefreshed) return { kind: 'refresh' };
  if (!login) return { kind: 'unavailable', reason: 'no Claude Code login was found for the benchmark arms; run claude and log in, or set GLIMMERVOID_CLAUDE_OAUTH_TOKEN' };
  return { kind: 'unavailable', reason: exhaustedLoginReason(login, nowMs, cellTimeoutSeconds, expiresAtBeforeRefresh) };
}

export { LOGIN_REFRESH_MARGIN_MS, decideArmToken, parseStoredCredentials, requiredValidUntil };
export type { ArmTokenDecision, LoginAccessToken };
