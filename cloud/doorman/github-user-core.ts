import { z } from 'zod';
import { GithubRepositoryName, MAX_BOUND_REPOSITORIES } from '../../shared/contracts/github-connection.ts';
import type { GithubInstallationBinding, GithubUserRecord } from '../../shared/contracts/github-connection.ts';
import { GithubLogin, MAX_BOUND_INSTALLATIONS } from '../../shared/contracts/watcher-link.ts';
import type { GithubConnection } from '../../shared/contracts/watcher-link.ts';

type UserTokens = { accessToken: string; accessExpiresAtMs: number; refreshToken: string; refreshTokenExpiresAtMs: number };
type TokenOutcome =
  | { kind: 'tokens'; tokens: UserTokens }
  | { kind: 'pending' }
  | { kind: 'slow-down'; intervalSeconds: number | null }
  | { kind: 'code-expired' }
  | { kind: 'denied' }
  | { kind: 'device-flow-off' }
  | { kind: 'refresh-refused' }
  | { kind: 'user-tokens-never-expire' }
  | { kind: 'unexpected'; reason: string };

type PendingDeviceCode = { deviceCode: string; userCode: string; verificationUri: string; expiresAtMs: number; intervalMs: number };

const GITHUB_WEB_ORIGIN = 'https://github.com';
const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const SLOW_DOWN_STEP_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const ACCESS_TOKEN_REFRESH_LEAD_MS = 5 * 60_000;
const INSTALLATIONS_STALE_AFTER_MS = 8 * 60 * 60_000;
const MS_PER_SECOND = 1000;

const DeviceCodeAnswer = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1).max(20),
  verification_uri: z.url({ protocol: /^https$/ }),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive().optional(),
});

const TokenSuccess = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1),
  refresh_token_expires_in: z.number().int().positive(),
});
const NonExpiringTokenSuccess = z.object({ access_token: z.string().min(1) });
const TokenError = z.object({ error: z.string().min(1), interval: z.number().int().positive().optional() });

const UserAnswer = z.object({ id: z.number().int().positive(), login: GithubLogin });
const InstallationsPage = z.object({
  total_count: z.number().int().nonnegative(),
  installations: z.array(z.object({ id: z.number().int().positive(), account: z.object({ login: GithubLogin }).nullable() })),
});
const RepositoriesPage = z.object({
  total_count: z.number().int().nonnegative(),
  repositories: z.array(z.object({ name: GithubRepositoryName })),
});

const TOKEN_ERROR_OUTCOMES: Readonly<Record<string, TokenOutcome['kind']>> = Object.freeze({
  authorization_pending: 'pending',
  slow_down: 'slow-down',
  expired_token: 'code-expired',
  access_denied: 'denied',
  device_flow_disabled: 'device-flow-off',
  bad_refresh_token: 'refresh-refused',
});

function pendingFromDeviceCode(raw: unknown, nowMs: number): PendingDeviceCode | null {
  const parsed = DeviceCodeAnswer.safeParse(raw);
  if (!parsed.success) return null;
  return {
    deviceCode: parsed.data.device_code,
    userCode: parsed.data.user_code,
    verificationUri: parsed.data.verification_uri,
    expiresAtMs: nowMs + parsed.data.expires_in * MS_PER_SECOND,
    intervalMs: (parsed.data.interval ?? DEFAULT_POLL_INTERVAL_MS / MS_PER_SECOND) * MS_PER_SECOND,
  };
}

function tokenOutcomeOf(raw: unknown, nowMs: number): TokenOutcome {
  const success = TokenSuccess.safeParse(raw);
  if (success.success) {
    return {
      kind: 'tokens',
      tokens: {
        accessToken: success.data.access_token,
        accessExpiresAtMs: nowMs + success.data.expires_in * MS_PER_SECOND,
        refreshToken: success.data.refresh_token,
        refreshTokenExpiresAtMs: nowMs + success.data.refresh_token_expires_in * MS_PER_SECOND,
      },
    };
  }
  if (NonExpiringTokenSuccess.safeParse(raw).success) return { kind: 'user-tokens-never-expire' };
  const failure = TokenError.safeParse(raw);
  if (!failure.success) return { kind: 'unexpected', reason: 'GitHub answered in an unknown shape' };
  const kind = TOKEN_ERROR_OUTCOMES[failure.data.error];
  if (kind === 'slow-down') return { kind, intervalSeconds: failure.data.interval ?? null };
  if (kind === undefined || kind === 'tokens' || kind === 'unexpected' || kind === 'user-tokens-never-expire') return { kind: 'unexpected', reason: `GitHub answered ${failure.data.error}` };
  return { kind };
}

function slowedIntervalMs(currentIntervalMs: number, suggestedSeconds: number | null): number {
  const steppedMs = currentIntervalMs + SLOW_DOWN_STEP_MS;
  return suggestedSeconds === null ? steppedMs : Math.max(steppedMs, suggestedSeconds * MS_PER_SECOND);
}

function deviceCodeRequestBody(clientId: string): URLSearchParams {
  return new URLSearchParams({ client_id: clientId });
}

function deviceTokenRequestBody(clientId: string, deviceCode: string): URLSearchParams {
  return new URLSearchParams({ client_id: clientId, device_code: deviceCode, grant_type: DEVICE_CODE_GRANT_TYPE });
}

function refreshRequestBody(clientId: string, refreshToken: string): URLSearchParams {
  return new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken });
}

function isAccessTokenUsable(accessExpiresAtMs: number, nowMs: number): boolean {
  return accessExpiresAtMs - nowMs > ACCESS_TOKEN_REFRESH_LEAD_MS;
}

function isRefreshTokenExpired(record: GithubUserRecord, nowMs: number): boolean {
  return nowMs >= record.refreshTokenExpiresAtMs;
}

function areInstallationsStale(record: GithubUserRecord, nowMs: number): boolean {
  return nowMs - record.installationsReadAtMs >= INSTALLATIONS_STALE_AFTER_MS;
}

function installUrlFor(appSlug: string): string {
  return `${GITHUB_WEB_ORIGIN}/apps/${appSlug}/installations/new`;
}

function userOf(raw: unknown): { userId: number; login: string } | null {
  const parsed = UserAnswer.safeParse(raw);
  return parsed.success ? { userId: parsed.data.id, login: parsed.data.login } : null;
}

function installationsPageOf(raw: unknown): { total: number; installations: { installationId: number; accountLogin: string }[] } | null {
  const parsed = InstallationsPage.safeParse(raw);
  if (!parsed.success) return null;
  const installations = parsed.data.installations.flatMap((installation) => installation.account === null ? [] : [{ installationId: installation.id, accountLogin: installation.account.login }]);
  return { total: parsed.data.total_count, installations };
}

function repositoriesPageOf(raw: unknown): { total: number; names: string[] } | null {
  const parsed = RepositoriesPage.safeParse(raw);
  return parsed.success ? { total: parsed.data.total_count, names: parsed.data.repositories.map((repository) => repository.name) } : null;
}

function boundInstallations(installations: readonly GithubInstallationBinding[]): GithubInstallationBinding[] {
  return installations
    .filter((installation) => installation.repositories.length > 0)
    .slice(0, MAX_BOUND_INSTALLATIONS)
    .map((installation) => ({ ...installation, repositories: [...installation.repositories].sort().slice(0, MAX_BOUND_REPOSITORIES) }));
}

function connectionOf({ record, pending, appSlug, nowMs }: { record: GithubUserRecord | null; pending: PendingDeviceCode | null; appSlug: string; nowMs: number }): GithubConnection {
  if (pending !== null && nowMs < pending.expiresAtMs) return { state: 'awaiting-code', userCode: pending.userCode, verificationUri: pending.verificationUri, expiresAtMs: pending.expiresAtMs };
  if (record === null) return { state: 'disconnected' };
  if (record.reconnectReason !== null) return { state: 'reconnect-needed', login: record.login, reason: record.reconnectReason };
  if (isRefreshTokenExpired(record, nowMs)) return { state: 'reconnect-needed', login: record.login, reason: 'expired' };
  if (record.installations.length === 0) return { state: 'needs-install', login: record.login, installUrl: installUrlFor(appSlug) };
  return { state: 'connected', login: record.login, accounts: record.installations.map((installation) => installation.accountLogin), refreshTokenExpiresAtMs: record.refreshTokenExpiresAtMs };
}

export { areInstallationsStale, boundInstallations, connectionOf, deviceCodeRequestBody, deviceTokenRequestBody, installationsPageOf, installUrlFor, isAccessTokenUsable, isRefreshTokenExpired, pendingFromDeviceCode, refreshRequestBody, repositoriesPageOf, slowedIntervalMs, tokenOutcomeOf, userOf };
export type { PendingDeviceCode, TokenOutcome, UserTokens };
