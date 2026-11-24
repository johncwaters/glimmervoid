import { z } from 'zod';
import { antigravityLoginOf } from './keyring-login-core.ts';

const MIN_REFRESH_LEAD_MS = 5 * 60_000;
const LIFETIME_LEAD_DIVISOR = 5;
const CLI_WINDOW_LEAD_MS = 4 * 60_000;
const AGENTS_REFRESHING_ONLY_NEAR_EXPIRY: readonly string[] = Object.freeze(['claude-code', 'codex']);
const ANTIGRAVITY_REFRESH_LEAD_MS = 8_000;
const KIMI_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';

const ClaudeLogin = z.object({ claudeAiOauth: z.object({ expiresAt: z.number() }) });
const CodexLogin = z.object({ tokens: z.object({ access_token: z.string() }) });
const CodexAccessClaims = z.object({ exp: z.number() });
const KimiLogin = z.object({ expires_at: z.number() });
const KimiTokenReply = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.coerce.number().positive(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

function nextRefreshAtMs(agent: string, expiresAtMs: number, lifetimeMs: number): number {
  if (agent === 'antigravity') return expiresAtMs - ANTIGRAVITY_REFRESH_LEAD_MS;
  if (AGENTS_REFRESHING_ONLY_NEAR_EXPIRY.includes(agent)) return expiresAtMs - CLI_WINDOW_LEAD_MS;
  return expiresAtMs - Math.max(MIN_REFRESH_LEAD_MS, lifetimeMs / LIFETIME_LEAD_DIVISOR);
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function codexExpiryAtMs(accessToken: string): number | null {
  const payload = accessToken.split('.')[1];
  if (payload === undefined) return null;
  const claims = CodexAccessClaims.safeParse(parsedJson(Buffer.from(payload, 'base64url').toString('utf8')));
  return claims.success ? claims.data.exp * 1000 : null;
}

function loginExpiryAtMs(agent: string, loginFileText: string): number | null {
  const login = parsedJson(loginFileText);
  if (agent === 'claude-code') {
    const claude = ClaudeLogin.safeParse(login);
    return claude.success ? claude.data.claudeAiOauth.expiresAt : null;
  }
  if (agent === 'codex') {
    const codex = CodexLogin.safeParse(login);
    return codex.success ? codexExpiryAtMs(codex.data.tokens.access_token) : null;
  }
  if (agent === 'antigravity') return antigravityLoginOf(loginFileText)?.expiresAtMs ?? null;
  if (agent === 'kimi') {
    const kimi = KimiLogin.safeParse(login);
    return kimi.success ? kimi.data.expires_at * 1000 : null;
  }
  return null;
}

function kimiRefreshTokenOf(loginFileText: string): string | null {
  const login = z.object({ refresh_token: z.string().min(1) }).safeParse(parsedJson(loginFileText));
  return login.success ? login.data.refresh_token : null;
}

function kimiRefreshRequest(refreshToken: string, env: Readonly<Record<string, string | undefined>>, configuredOAuthHost: string): { url: string; body: string } {
  const oauthHost = env.KIMI_CODE_OAUTH_HOST?.trim() || env.KIMI_OAUTH_HOST?.trim() || configuredOAuthHost;
  const body = new URLSearchParams({ client_id: KIMI_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken }).toString();
  return { url: `${oauthHost.replace(/\/$/, '')}/api/oauth/token`, body };
}

function kimiLoginFileText(reply: unknown, nowMs: number): string | null {
  const parsed = KimiTokenReply.safeParse(reply);
  if (!parsed.success) return null;
  const token = parsed.data;
  const login = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: Math.floor(nowMs / 1000) + token.expires_in,
    scope: token.scope ?? '',
    token_type: token.token_type ?? 'Bearer',
    expires_in: token.expires_in,
  };
  return `${JSON.stringify(login, null, 2)}\n`;
}

export { kimiLoginFileText, kimiRefreshRequest, kimiRefreshTokenOf, loginExpiryAtMs, nextRefreshAtMs };
