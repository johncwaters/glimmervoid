import crypto from 'node:crypto';
import { z } from 'zod';
import { githubApiOrigin } from '../../shared/contracts/watcher-link.ts';
import type { DoormanGithubApp, DoormanGithubInstallation } from '../../shared/contracts/doorman.ts';
import { retryAfterMsFromHeaders } from '../watcher/core/probe-core.ts';
import { githubAppJwt, installationTokenRequestBody } from './doorman-core.ts';

type MintOutcome =
  | { kind: 'minted'; token: string; expiresAtMs: number }
  | { kind: 'failed'; reason: string; retryAfterMs: number | null };

const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const SECRET_MANAGER_ORIGIN = 'https://secretmanager.googleapis.com';
const KEY_VERSION_ALIAS = 'current';
const KEY_CACHE_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const GITHUB_API_VERSION = '2022-11-28';
const USER_AGENT = 'glimmervoid-doorman';

const MetadataToken = z.object({ access_token: z.string().min(1) });
const SecretVersionAccess = z.object({ payload: z.object({ data: z.string().min(1) }) });
const InstallationToken = z.object({ token: z.string().min(1), expires_at: z.iso.datetime() });

function createGithubAppMinter({ app, fetchFn = fetch, now = Date.now }: {
  app: DoormanGithubApp;
  fetchFn?: typeof fetch;
  now?: () => number;
}) {
  let cachedKey: { privateKey: crypto.KeyObject; readAtMs: number } | null = null;

  async function jsonFrom(url: string, init: RequestInit, what: string): Promise<unknown> {
    const response = await fetchFn(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${what} answered ${response.status}`);
    }
    return response.json();
  }

  async function readPrivateKey(): Promise<crypto.KeyObject> {
    if (cachedKey !== null && now() - cachedKey.readAtMs < KEY_CACHE_MS) return cachedKey.privateKey;
    const metadataToken = MetadataToken.parse(await jsonFrom(METADATA_TOKEN_URL, { headers: { 'metadata-flavor': 'Google' } }, 'the metadata server'));
    const secretUrl = `${SECRET_MANAGER_ORIGIN}/v1/${app.privateKeySecret}/versions/${KEY_VERSION_ALIAS}:access`;
    const secretVersion = SecretVersionAccess.parse(await jsonFrom(secretUrl, { headers: { authorization: `Bearer ${metadataToken.access_token}` } }, 'Secret Manager'));
    const privateKey = crypto.createPrivateKey(Buffer.from(secretVersion.payload.data, 'base64'));
    cachedKey = { privateKey, readAtMs: now() };
    return privateKey;
  }

  async function requestInstallationToken(installation: DoormanGithubInstallation, privateKey: crypto.KeyObject): Promise<MintOutcome> {
    const mintUrl = `${githubApiOrigin(process.env)}/app/installations/${installation.installationId}/access_tokens`;
    const response = await fetchFn(mintUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${githubAppJwt(app.clientId, privateKey, now())}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
        'x-github-api-version': GITHUB_API_VERSION,
      },
      body: installationTokenRequestBody(installation),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status !== 201) {
      await response.body?.cancel();
      const retryAfterMs = retryAfterMsFromHeaders({ status: response.status, hasErrorInAnswer: false }, {
        retryAfter: response.headers.get('retry-after'),
        rateLimitRemaining: response.headers.get('x-ratelimit-remaining'),
        rateLimitReset: response.headers.get('x-ratelimit-reset'),
      }, now());
      return { kind: 'failed', reason: `GitHub answered ${response.status}`, retryAfterMs };
    }
    const minted = InstallationToken.parse(await response.json());
    return { kind: 'minted', token: minted.token, expiresAtMs: Date.parse(minted.expires_at) };
  }

  async function mint(installation: DoormanGithubInstallation): Promise<MintOutcome> {
    try {
      return await requestInstallationToken(installation, await readPrivateKey());
    } catch (mintError) {
      return { kind: 'failed', reason: mintError instanceof Error ? mintError.message : String(mintError), retryAfterMs: null };
    }
  }

  return { mint };
}

type GithubAppMinter = ReturnType<typeof createGithubAppMinter>;

export { createGithubAppMinter };
export type { GithubAppMinter };
