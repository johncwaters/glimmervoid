import crypto from 'node:crypto';
import { z } from 'zod';
import { githubApiOrigin } from '../../shared/contracts/watcher-link.ts';
import type { DoormanGithubApp, DoormanGithubInstallation } from '../../shared/contracts/doorman.ts';
import { retryAfterMsFromHeaders } from '../watcher/core/probe-core.ts';
import { githubAppJwt, installationTokenRequestBody } from './doorman-core.ts';
import { clock } from '../../shared/clock.ts';
import { createGcpRest } from './gcp-rest.ts';

type MintOutcome =
  | { kind: 'minted'; token: string; expiresAtMs: number }
  | { kind: 'failed'; reason: string; retryAfterMs: number | null };

const KEY_VERSION_ALIAS = 'current';
const KEY_CACHE_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const GITHUB_API_VERSION = '2022-11-28';
const USER_AGENT = 'glimmervoid-doorman';

const InstallationToken = z.object({ token: z.string().min(1), expires_at: z.iso.datetime() });

function createGithubAppMinter({ app, fetchFn = fetch, now = clock.nowMs }: {
  app: DoormanGithubApp;
  fetchFn?: typeof fetch;
  now?: () => number;
}) {
  let cachedKey: { privateKey: crypto.KeyObject; readAtMs: number } | null = null;

  const google = createGcpRest({ fetchFn });

  async function readPrivateKey(): Promise<crypto.KeyObject> {
    if (cachedKey !== null && now() - cachedKey.readAtMs < KEY_CACHE_MS) return cachedKey.privateKey;
    const privateKey = crypto.createPrivateKey(await google.secretPayload(app.privateKeySecret, KEY_VERSION_ALIAS));
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
