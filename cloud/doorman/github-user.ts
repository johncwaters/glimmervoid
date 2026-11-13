import { githubApiOrigin, MAX_BOUND_INSTALLATIONS } from '../../shared/contracts/watcher-link.ts';
import type { GithubConnection } from '../../shared/contracts/watcher-link.ts';
import { MAX_BOUND_REPOSITORIES, StoredGithubUser } from '../../shared/contracts/github-connection.ts';
import type { GithubInstallationBinding, GithubUserRecord } from '../../shared/contracts/github-connection.ts';
import type { DoormanGithubApp } from '../../shared/contracts/doorman.ts';
import { openSealed, sealBytes } from '../watcher/core/sealed-box.ts';
import { areInstallationsStale, boundInstallations, connectionOf, deviceCodeRequestBody, deviceTokenRequestBody, installationsPageOf, isAccessTokenUsable, isRefreshTokenExpired, pendingFromDeviceCode, refreshRequestBody, repositoriesPageOf, slowedIntervalMs, tokenOutcomeOf, userOf } from './github-user-core.ts';
import type { PendingDeviceCode, UserTokens } from './github-user-core.ts';
import type { TenantRecordStore } from './tenant-record-store.ts';
import { clock } from '../../shared/clock.ts';
import { errorMessage } from '../../shared/text.ts';
import { parseJsonOrNull } from '../../server/core/json-core.ts';

type LoadedRecord = { record: GithubUserRecord | null; generation: string | null };
type UserAccessGrant = { token: string; expiresAtMs: number; login: string };
type RecordChange = (current: GithubUserRecord | null) => GithubUserRecord | null | undefined;
type AppSetupProblem = 'device-flow-off' | 'user-tokens-never-expire';
type FormAnswer = { status: number; body: unknown };

const GITHUB_USER_RECORD_NAME = 'github-user';
const GITHUB_WEB_ORIGIN = 'https://github.com';
const DEVICE_CODE_PATH = '/login/device/code';
const ACCESS_TOKEN_PATH = '/login/oauth/access_token';
const REQUEST_TIMEOUT_MS = 15_000;
const GITHUB_API_VERSION = '2022-11-28';
const USER_AGENT = 'glimmervoid-doorman';
const PAGE_SIZE = 100;
const MAX_RECORD_WRITE_ATTEMPTS = 3;
const writeQueuesByStore = new WeakMap<TenantRecordStore, Map<string, Promise<unknown>>>();

function queuedForTenant<T>(store: TenantRecordStore, slug: string, work: () => Promise<T>): Promise<T> {
  const queues = writeQueuesByStore.get(store) ?? new Map<string, Promise<unknown>>();
  writeQueuesByStore.set(store, queues);
  const queued = (queues.get(slug) ?? Promise.resolve()).then(work);
  const settled = queued.catch(() => undefined);
  queues.set(slug, settled);
  void settled.then(() => {
    if (queues.get(slug) === settled) queues.delete(slug);
  });
  return queued;
}

function createGithubUserLink({ slug, app, store, sealKey, fetchFn = fetch, now = clock.nowMs, log = console, onChange = () => {} }: {
  slug: string;
  app: () => DoormanGithubApp | null;
  store: TenantRecordStore;
  sealKey: Buffer;
  fetchFn?: typeof fetch;
  now?: () => number;
  log?: Pick<Console, 'log' | 'warn'>;
  onChange?: () => void;
}) {
  let pending: PendingDeviceCode | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let appSetupProblem: AppSetupProblem | null = null;
  let held: UserAccessGrant | null = null;
  let refreshing: Promise<UserAccessGrant | null> | null = null;
  let isStopped = false;

  async function loadRecord(): Promise<LoadedRecord> {
    const stored = await store.read(slug, GITHUB_USER_RECORD_NAME);
    if (stored === null) return { record: null, generation: null };
    const opened = openSealed(sealKey, stored.bytes);
    const parsed = opened === null ? null : StoredGithubUser.safeParse(parseJsonOrNull(opened.toString('utf8')));
    if (parsed === null || !parsed.success) {
      log.warn(`[doorman] tenant ${slug} GitHub record does not open under this link secret; treating it as disconnected`);
      return { record: null, generation: stored.generation };
    }
    return { record: parsed.data.record, generation: stored.generation };
  }

  function saveRecord(record: GithubUserRecord | null, ifGeneration: string | null) {
    const sealed = sealBytes(sealKey, Buffer.from(JSON.stringify(StoredGithubUser.parse({ record })), 'utf8'));
    return store.write(slug, GITHUB_USER_RECORD_NAME, sealed, ifGeneration);
  }

  function exclusively<T>(work: () => Promise<T>): Promise<T> {
    return queuedForTenant(store, slug, work);
  }

  async function rewriteRecord(change: RecordChange): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_RECORD_WRITE_ATTEMPTS; attempt += 1) {
      const loaded = await loadRecord();
      const nextRecord = change(loaded.record);
      if (nextRecord === undefined) return false;
      if (await saveRecord(nextRecord, loaded.generation) === 'written') return true;
    }
    throw new Error(`tenant ${slug} GitHub record kept changing under this write`);
  }

  function replaceRecord(change: RecordChange): Promise<boolean> {
    return exclusively(() => rewriteRecord(change));
  }

  async function postForm(url: string, form: URLSearchParams): Promise<FormAnswer> {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
      body: form.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  async function getAsUser(pathAndQuery: string, accessToken: string): Promise<unknown> {
    const response = await fetchFn(`${githubApiOrigin(process.env)}${pathAndQuery}`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json', 'user-agent': USER_AGENT, 'x-github-api-version': GITHUB_API_VERSION },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub answered ${response.status} for ${pathAndQuery.split('?')[0]}`);
    }
    return response.json();
  }

  async function repositoriesOf(installationId: number, accessToken: string): Promise<string[]> {
    const names: string[] = [];
    for (let page = 1; names.length < MAX_BOUND_REPOSITORIES; page += 1) {
      const repositoriesPage = repositoriesPageOf(await getAsUser(`/user/installations/${installationId}/repositories?per_page=${PAGE_SIZE}&page=${page}`, accessToken));
      if (repositoriesPage === null) throw new Error('GitHub listed repositories in an unknown shape');
      names.push(...repositoriesPage.names);
      if (repositoriesPage.total > MAX_BOUND_REPOSITORIES && page === 1) log.warn(`[doorman] tenant ${slug} installation ${installationId} reaches ${repositoriesPage.total} repositories; binding the first ${MAX_BOUND_REPOSITORIES} by name`);
      if (repositoriesPage.names.length < PAGE_SIZE || names.length >= repositoriesPage.total) return names;
    }
    return names;
  }

  async function readBindings(accessToken: string): Promise<GithubInstallationBinding[]> {
    const installations: { installationId: number; accountLogin: string }[] = [];
    for (let page = 1; installations.length < MAX_BOUND_INSTALLATIONS; page += 1) {
      const installationsPage = installationsPageOf(await getAsUser(`/user/installations?per_page=${PAGE_SIZE}&page=${page}`, accessToken));
      if (installationsPage === null) throw new Error('GitHub listed installations in an unknown shape');
      installations.push(...installationsPage.installations);
      if (installationsPage.installations.length < PAGE_SIZE || installations.length >= installationsPage.total) break;
    }
    const bindings: GithubInstallationBinding[] = [];
    for (const installation of installations) bindings.push({ ...installation, repositories: await repositoriesOf(installation.installationId, accessToken) });
    return boundInstallations(bindings);
  }

  async function recordFromTokens(tokens: UserTokens): Promise<GithubUserRecord> {
    const user = userOf(await getAsUser('/user', tokens.accessToken));
    if (user === null) throw new Error('GitHub answered /user in an unknown shape');
    return {
      ...user,
      refreshToken: tokens.refreshToken,
      refreshTokenExpiresAtMs: tokens.refreshTokenExpiresAtMs,
      installations: await readBindings(tokens.accessToken),
      installationsReadAtMs: now(),
      reconnectReason: null,
    };
  }

  function holdTokens(tokens: UserTokens, login: string): UserAccessGrant {
    held = { token: tokens.accessToken, expiresAtMs: tokens.accessExpiresAtMs, login };
    return held;
  }

  async function markReconnectNeeded(reason: 'expired' | 'revoked', endedRefreshToken: string): Promise<void> {
    held = null;
    const isMarked = await rewriteRecord((current) => current?.refreshToken === endedRefreshToken ? { ...current, reconnectReason: reason } : undefined);
    if (!isMarked) return;
    log.warn(`[doorman] tenant ${slug} GitHub connection needs a reconnect (${reason})`);
    onChange();
  }

  async function refreshNow(): Promise<UserAccessGrant | null> {
    const currentApp = app();
    const record = (await loadRecord()).record;
    if (isStopped || currentApp === null || record === null || record.reconnectReason !== null) return null;
    if (isRefreshTokenExpired(record, now())) {
      await markReconnectNeeded('expired', record.refreshToken);
      return null;
    }
    const outcome = tokenOutcomeOf((await postForm(`${GITHUB_WEB_ORIGIN}${ACCESS_TOKEN_PATH}`, refreshRequestBody(currentApp.clientId, record.refreshToken))).body, now());
    if (outcome.kind === 'refresh-refused') {
      await markReconnectNeeded('revoked', record.refreshToken);
      return null;
    }
    if (outcome.kind !== 'tokens') throw new Error(`GitHub did not refresh the user token: ${outcome.kind}`);
    const freshBindings = await withFreshBindings(record, outcome.tokens.accessToken);
    const isSaved = await rewriteRecord((current) => current?.refreshToken === record.refreshToken
      ? { ...current, ...freshBindings, refreshToken: outcome.tokens.refreshToken, refreshTokenExpiresAtMs: outcome.tokens.refreshTokenExpiresAtMs }
      : undefined);
    if (!isSaved) {
      held = null;
      log.warn(`[doorman] tenant ${slug} GitHub record moved on during a refresh; dropping the refreshed tokens`);
      return null;
    }
    if (JSON.stringify(freshBindings.installations) !== JSON.stringify(record.installations)) onChange();
    return holdTokens(outcome.tokens, record.login);
  }

  async function withFreshBindings(record: GithubUserRecord, accessToken: string): Promise<Pick<GithubUserRecord, 'installations' | 'installationsReadAtMs'>> {
    try {
      return { installations: await readBindings(accessToken), installationsReadAtMs: now() };
    } catch (readError) {
      log.warn(`[doorman] tenant ${slug} kept its old GitHub installations: ${errorMessage(readError)}`);
      return { installations: record.installations, installationsReadAtMs: record.installationsReadAtMs };
    }
  }

  function freshAccessToken(): Promise<UserAccessGrant | null> {
    if (held !== null && isAccessTokenUsable(held.expiresAtMs, now())) return Promise.resolve(held);
    if (refreshing !== null) return refreshing;
    const refresh = exclusively(refreshNow).finally(() => {
      refreshing = null;
    });
    refreshing = refresh;
    return refresh;
  }

  function stopPolling(): void {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function schedulePoll(clientId: string, code: PendingDeviceCode): void {
    stopPolling();
    pollTimer = setTimeout(() => void pollOnce(clientId, code), code.intervalMs);
    pollTimer.unref();
  }

  async function pollOnce(clientId: string, code: PendingDeviceCode): Promise<void> {
    pollTimer = null;
    if (isStopped || pending !== code) return;
    if (now() >= code.expiresAtMs) {
      pending = null;
      onChange();
      return;
    }
    const outcome = await postForm(`${GITHUB_WEB_ORIGIN}${ACCESS_TOKEN_PATH}`, deviceTokenRequestBody(clientId, code.deviceCode))
      .then((answer) => tokenOutcomeOf(answer.body, now()))
      .catch((pollError: unknown) => ({ kind: 'unexpected' as const, reason: errorMessage(pollError) }));
    if (pending !== code) return;
    if (outcome.kind === 'unexpected') log.warn(`[doorman] tenant ${slug} GitHub device poll: ${outcome.reason}`);
    if (outcome.kind === 'pending' || outcome.kind === 'unexpected') return schedulePoll(clientId, code);
    if (outcome.kind === 'slow-down') return schedulePoll(clientId, { ...code, intervalMs: slowedIntervalMs(code.intervalMs, outcome.intervalSeconds) });
    if (outcome.kind !== 'tokens') {
      pending = null;
      if (outcome.kind === 'device-flow-off' || outcome.kind === 'user-tokens-never-expire') appSetupProblem = outcome.kind;
      log.log(`[doorman] tenant ${slug} GitHub device code ended: ${outcome.kind}`);
      onChange();
      return;
    }
    await adoptAuthorization(code, outcome.tokens).catch((adoptError: unknown) => log.warn(`[doorman] tenant ${slug} GitHub sign-in did not save: ${errorMessage(adoptError)}`));
    if (pending === code) pending = null;
    onChange();
  }

  async function adoptAuthorization(code: PendingDeviceCode, tokens: UserTokens): Promise<void> {
    const record = await recordFromTokens(tokens);
    const isAdopted = await exclusively(async () => pending === code && !isStopped && await rewriteRecord(() => record));
    if (!isAdopted) {
      log.log(`[doorman] tenant ${slug} GitHub sign-in finished after a disconnect; dropping it`);
      return;
    }
    holdTokens(tokens, record.login);
    log.log(`[doorman] tenant ${slug} connected GitHub as ${record.login} with ${record.installations.length} installation(s)`);
  }

  async function connect(): Promise<GithubConnection> {
    const currentApp = app();
    if (currentApp === null) return { state: 'unavailable', reason: 'no-app' };
    if (pending !== null && now() < pending.expiresAtMs) return connection();
    const answer = await postForm(`${GITHUB_WEB_ORIGIN}${DEVICE_CODE_PATH}`, deviceCodeRequestBody(currentApp.clientId));
    if (tokenOutcomeOf(answer.body, now()).kind === 'device-flow-off') {
      appSetupProblem = 'device-flow-off';
      return { state: 'unavailable', reason: 'device-flow-off' };
    }
    const code = pendingFromDeviceCode(answer.body, now());
    if (code === null) throw new Error(`GitHub issued no device code (HTTP ${answer.status})`);
    appSetupProblem = null;
    pending = code;
    schedulePoll(currentApp.clientId, code);
    return connection();
  }

  async function connection(): Promise<GithubConnection> {
    const currentApp = app();
    if (currentApp === null) return { state: 'unavailable', reason: 'no-app' };
    if (appSetupProblem !== null && pending === null) return { state: 'unavailable', reason: appSetupProblem };
    const { record } = await loadRecord();
    const current = connectionOf({ record, pending, appSlug: currentApp.slug, nowMs: now() });
    if (current.state !== 'needs-install') return current;
    await recheckInstallations();
    return connectionOf({ record: (await loadRecord()).record, pending, appSlug: currentApp.slug, nowMs: now() });
  }

  async function recheckInstallations(): Promise<void> {
    const access = await freshAccessToken().catch((refreshError: unknown) => {
      log.warn(`[doorman] tenant ${slug} could not refresh its GitHub user token: ${errorMessage(refreshError)}`);
      return null;
    });
    if (access === null) return;
    const bindings = await readBindings(access.token).catch(() => null);
    if (bindings === null) return;
    await replaceRecord((current) => current === null ? undefined : { ...current, installations: bindings, installationsReadAtMs: now() });
    if (bindings.length > 0) onChange();
  }

  async function disconnect(): Promise<GithubConnection> {
    pending = null;
    stopPolling();
    held = null;
    await replaceRecord(() => null);
    onChange();
    return connection();
  }

  async function bindings(): Promise<GithubInstallationBinding[]> {
    const { record } = await loadRecord();
    if (record === null || record.reconnectReason !== null) return [];
    if (!areInstallationsStale(record, now())) return record.installations;
    await freshAccessToken().catch((refreshError: unknown) => log.warn(`[doorman] tenant ${slug} kept stale GitHub installations: ${errorMessage(refreshError)}`));
    const reloaded = (await loadRecord()).record;
    return reloaded === null || reloaded.reconnectReason !== null ? [] : reloaded.installations;
  }

  function stop(): void {
    isStopped = true;
    pending = null;
    stopPolling();
  }

  return { connect, connection, disconnect, bindings, userAccessGrant: freshAccessToken, stop };
}

type GithubUserLink = ReturnType<typeof createGithubUserLink>;

export { createGithubUserLink };
export type { GithubUserLink, UserAccessGrant };
