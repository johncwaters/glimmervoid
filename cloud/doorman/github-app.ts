import crypto from 'node:crypto';
import { z } from 'zod';
import { githubApiOrigin } from '../../shared/contracts/watcher-link.ts';
import type { DoormanGithubApp } from '../../shared/contracts/doorman.ts';
import type { GithubInstallationBinding } from '../../shared/contracts/github-connection.ts';
import { retryAfterMsFromHeaders } from '../watcher/core/probe-core.ts';
import { githubAppJwt, installationTokenRequestBody, reachabilityTokenRequestBody, reachableSubset } from './doorman-core.ts';
import { repositoriesPageOf } from './github-user-core.ts';
import { clock } from '../../shared/clock.ts';
import { createGcpRest } from './gcp-rest.ts';
import { parseJsonOrNull } from '../../server/core/json-core.ts';
import { sanitizeOneLine } from '../../server/core/text-core.ts';

type MintOutcome =
  | { kind: 'minted'; token: string; expiresAtMs: number; droppedRepositories: readonly string[] }
  | { kind: 'failed'; reason: string; retryAfterMs: number | null };

type TokenAttempt =
  | { kind: 'minted'; token: string; expiresAtMs: number }
  | { kind: 'failed'; status: number; reason: string; retryAfterMs: number | null };

const KEY_VERSION_ALIAS = 'current';
const KEY_CACHE_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const GITHUB_API_VERSION = '2022-11-28';
const USER_AGENT = 'glimmervoid-doorman';

const MAX_REFUSAL_MESSAGE_CHARS = 200;
const UNREACHABLE_REPOSITORY_STATUS = 422;
const REACHABLE_PAGE_SIZE = 100;
const MAX_REACHABLE_PAGES = 30;

const InstallationToken = z.object({ token: z.string().min(1), expires_at: z.iso.datetime() });
const GithubErrorAnswer = z.object({ message: z.string().min(1) });

async function refusalReasonOf(response: Response): Promise<string> {
  const statusReason = `GitHub answered ${response.status}`;
  const errorAnswer = GithubErrorAnswer.safeParse(parseJsonOrNull(await response.text().catch(() => '')));
  if (!errorAnswer.success) return statusReason;
  const message = sanitizeOneLine(errorAnswer.data.message, MAX_REFUSAL_MESSAGE_CHARS);
  return message === '' ? statusReason : `${statusReason}: ${message}`;
}

function createGithubAppMinter({ app, privateKeySecret, fetchFn = fetch, now = clock.nowMs }: {
  app: DoormanGithubApp;
  privateKeySecret: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}) {
  let cachedKey: { privateKey: crypto.KeyObject; readAtMs: number } | null = null;

  const google = createGcpRest({ fetchFn });

  async function readPrivateKey(): Promise<crypto.KeyObject> {
    if (cachedKey !== null && now() - cachedKey.readAtMs < KEY_CACHE_MS) return cachedKey.privateKey;
    const privateKey = crypto.createPrivateKey(await google.secretPayload(privateKeySecret, KEY_VERSION_ALIAS));
    cachedKey = { privateKey, readAtMs: now() };
    return privateKey;
  }

  function githubHeaders(authorization: string): Record<string, string> {
    return { authorization, accept: 'application/vnd.github+json', 'user-agent': USER_AGENT, 'x-github-api-version': GITHUB_API_VERSION };
  }

  async function requestToken(installationId: number, body: string, privateKey: crypto.KeyObject): Promise<TokenAttempt> {
    const mintUrl = `${githubApiOrigin(process.env)}/app/installations/${installationId}/access_tokens`;
    const response = await fetchFn(mintUrl, {
      method: 'POST',
      headers: { ...githubHeaders(`Bearer ${githubAppJwt(app.clientId, privateKey, now())}`), 'content-type': 'application/json' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status !== 201) {
      const reason = await refusalReasonOf(response);
      const retryAfterMs = retryAfterMsFromHeaders({ status: response.status, hasErrorInAnswer: false }, {
        retryAfter: response.headers.get('retry-after'),
        rateLimitRemaining: response.headers.get('x-ratelimit-remaining'),
        rateLimitReset: response.headers.get('x-ratelimit-reset'),
      }, now());
      return { kind: 'failed', status: response.status, reason, retryAfterMs };
    }
    const minted = InstallationToken.parse(await response.json());
    return { kind: 'minted', token: minted.token, expiresAtMs: Date.parse(minted.expires_at) };
  }

  async function reachableRepositoryNames(installationId: number, privateKey: crypto.KeyObject): Promise<ReadonlySet<string> | null> {
    const listingToken = await requestToken(installationId, reachabilityTokenRequestBody(), privateKey);
    if (listingToken.kind === 'failed') return null;
    const reachableNames = new Set<string>();
    for (let page = 1; page <= MAX_REACHABLE_PAGES; page += 1) {
      const response = await fetchFn(`${githubApiOrigin(process.env)}/installation/repositories?per_page=${REACHABLE_PAGE_SIZE}&page=${page}`, {
        headers: githubHeaders(`Bearer ${listingToken.token}`),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const repositoriesPage = repositoriesPageOf(await response.json());
      if (repositoriesPage === null) return null;
      for (const name of repositoriesPage.names) reachableNames.add(name);
      if (repositoriesPage.names.length < REACHABLE_PAGE_SIZE || reachableNames.size >= repositoriesPage.total) return reachableNames;
    }
    return null;
  }

  function failedOutcomeOf(attempt: Extract<TokenAttempt, { kind: 'failed' }>): MintOutcome {
    return { kind: 'failed', reason: attempt.reason, retryAfterMs: attempt.retryAfterMs };
  }

  async function mintWithReachableRepositories(installation: GithubInstallationBinding, privateKey: crypto.KeyObject): Promise<MintOutcome> {
    const scoped = await requestToken(installation.installationId, installationTokenRequestBody(installation.repositories), privateKey);
    if (scoped.kind === 'minted') return { ...scoped, droppedRepositories: [] };
    if (scoped.status !== UNREACHABLE_REPOSITORY_STATUS) return failedOutcomeOf(scoped);
    const reachableNames = await reachableRepositoryNames(installation.installationId, privateKey).catch((listingError: unknown) => new Error(sanitizeOneLine(listingError instanceof Error ? listingError.message : String(listingError), MAX_REFUSAL_MESSAGE_CHARS)));
    if (reachableNames instanceof Error) return { kind: 'failed', reason: `${scoped.reason}; listing the repositories the installation reaches failed: ${reachableNames.message}`, retryAfterMs: scoped.retryAfterMs };
    if (reachableNames === null) return failedOutcomeOf(scoped);
    const { kept, dropped } = reachableSubset(installation.repositories, reachableNames);
    if (dropped.length === 0) return failedOutcomeOf(scoped);
    if (kept.length === 0) return { kind: 'failed', reason: `${scoped.reason}; the installation reaches none of its ${dropped.length} bound repositories`, retryAfterMs: scoped.retryAfterMs };
    const retried = await requestToken(installation.installationId, installationTokenRequestBody(kept), privateKey);
    if (retried.kind === 'failed') return failedOutcomeOf(retried);
    return { ...retried, droppedRepositories: dropped };
  }

  async function mint(installation: GithubInstallationBinding): Promise<MintOutcome> {
    try {
      return await mintWithReachableRepositories(installation, await readPrivateKey());
    } catch (mintError) {
      return { kind: 'failed', reason: mintError instanceof Error ? mintError.message : String(mintError), retryAfterMs: null };
    }
  }

  return { mint };
}

type GithubAppMinter = ReturnType<typeof createGithubAppMinter>;

export { createGithubAppMinter };
export type { GithubAppMinter };
