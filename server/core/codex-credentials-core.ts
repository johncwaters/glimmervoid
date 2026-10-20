import { z } from 'zod';

const CODEX_LOGIN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const StoredCodexAuth = z.object({
  tokens: z.object({
    access_token: z.string().min(1),
    account_id: z.string().min(1),
  }),
});

const AccessTokenClaims = z.object({ exp: z.number().positive() });

interface CodexLogin {
  accessToken: string;
  accountId: string;
  expiresAtMs: number | null;
}

type CodexLoginDecision =
  | { kind: 'use'; login: CodexLogin }
  | { kind: 'refresh' }
  | { kind: 'unavailable'; reason: string };

function accessTokenExpiryMs(accessToken: string): number | null {
  const encodedClaims = accessToken.split('.')[1];
  if (!encodedClaims) return null;
  try {
    const claims = AccessTokenClaims.safeParse(JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8')));
    return claims.success ? claims.data.exp * 1000 : null;
  } catch {
    return null;
  }
}

function parseCodexAuth(text: string): CodexLogin | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = StoredCodexAuth.safeParse(decoded);
  if (!parsed.success) return null;
  const { access_token: accessToken, account_id: accountId } = parsed.data.tokens;
  return { accessToken, accountId, expiresAtMs: accessTokenExpiryMs(accessToken) };
}

function decideCodexLogin({ login, nowMs, hasRefreshed }: { login: CodexLogin | null; nowMs: number; hasRefreshed: boolean }): CodexLoginDecision {
  if (!login) return { kind: 'unavailable', reason: 'no Codex login was found on this host; run codex login, or connect Codex from Glimmervoid' };
  if (login.expiresAtMs === null || login.expiresAtMs - nowMs >= CODEX_LOGIN_REFRESH_MARGIN_MS) return { kind: 'use', login };
  if (!hasRefreshed) return { kind: 'refresh' };
  if (login.expiresAtMs > nowMs) return { kind: 'use', login };
  return { kind: 'unavailable', reason: 'the host Codex login has expired and a host refresh did not renew it; run codex login' };
}

function chatgptAuthTokensLogin(login: CodexLogin) {
  return { type: 'chatgptAuthTokens' as const, accessToken: login.accessToken, chatgptAccountId: login.accountId };
}

function chatgptAuthTokensRefreshResult(login: CodexLogin) {
  return { accessToken: login.accessToken, chatgptAccountId: login.accountId, chatgptPlanType: null };
}

export { chatgptAuthTokensLogin, chatgptAuthTokensRefreshResult, decideCodexLogin, parseCodexAuth };
export type { CodexLogin };
