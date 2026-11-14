import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execFileAsync } from './child-process-safe.ts';
import { runGit } from './git/git-exec.ts';
import { formatSshPublicKey, isSameSshKey, parseSshPublicKey } from './core/ssh-signing-core.ts';
import type { SshPublicKey } from './core/ssh-signing-core.ts';
import { CommitSigningRecord, GithubSigningKeyCreated, GithubSigningKeyList, GithubUser } from '../shared/contracts/commit-signing.ts';
import type { CommitSigningAction, CommitSigningStatus } from '../shared/contracts/commit-signing.ts';
import type { GithubConnection, GithubConnectionAction, GithubUserGrant } from '../shared/contracts/watcher-link.ts';
import { allowedSignersText, commitSigningStatusOf, githubNoreplyIdentity, githubRefusalText, hostGitConfigText, hostSigningGitEnv, includedSystemConfigPath, isHostSigningSystemConfig, OWN_SIGNING_SETTINGS_PATTERN, sshPublicKeyFingerprint } from './core/commit-signing-core.ts';
import { errorMessage } from '../shared/text.ts';

const KEY_FOLDER_MODE = 0o700;
const PRIVATE_KEY_FILE_NAME = 'signing-key';
const KEY_COMMENT = 'glimmervoid-commit-signing';
const SYSTEM_CONFIG_FILE_NAME = 'system.gitconfig';
const IDENTITY_CONFIG_FILE_NAME = 'identity.gitconfig';
const ALLOWED_SIGNERS_FILE_NAME = 'allowed-signers';
const RECORD_FILE_NAME = 'commit-signing.json';
const NO_REGISTRATION: CommitSigningRecord = { github: null, identity: null, isSwitchedOff: false };
const GITHUB_API_URL = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_REQUEST_TIMEOUT_MS = 15_000;
const GITHUB_KEY_TITLE = 'Glimmervoid commit signing';
const GIT_CONFIG_NO_MATCH_EXIT_CODE = 1;
const KEYGEN_TIMEOUT_MS = 30_000;
const SIGNING_TIMEOUT_MS = 60_000;

type SignOutcome = { ok: true; signature: string } | { ok: false; error: string };

interface HostSigningKey {
  publicKey: SshPublicKey;
  publicKeyText: string;
  fingerprint: string;
}

interface HostSigningKeyStore {
  read: () => Promise<HostSigningKey | null>;
  setup: () => Promise<HostSigningKey>;
  remove: () => Promise<void>;
  gitEnvFor: (cwd: string) => Promise<Record<string, string>>;
  readRecord: () => Promise<CommitSigningRecord>;
  writeRecord: (record: CommitSigningRecord) => Promise<void>;
  signIfHeld: (request: { publicKey: SshPublicKey; namespace: string; payload: Buffer }) => Promise<SignOutcome | null>;
}

function hostSigningKeyOf(publicKeyFileText: string): HostSigningKey | null {
  const publicKey = parseSshPublicKey(publicKeyFileText);
  if (!publicKey) return null;
  return { publicKey, publicKeyText: formatSshPublicKey(publicKey), fingerprint: sshPublicKeyFingerprint(publicKey) };
}

interface SystemConfigBase {
  baseSystemConfigPath: string | null;
  inheritsHostSigningConfig: boolean;
}

async function discoverSystemConfigBase(): Promise<SystemConfigBase> {
  const listing = await runGit(['config', '--system', '--null', '--list', '--show-origin'], { trim: false });
  const origin = listing.ok ? listing.out.split('\0')[0] ?? '' : '';
  if (!origin.startsWith('file:')) return { baseSystemConfigPath: null, inheritsHostSigningConfig: false };
  const systemConfigPath = origin.slice('file:'.length);
  const systemConfigText = await fs.readFile(systemConfigPath, 'utf8').catch(() => '');
  if (!isHostSigningSystemConfig(systemConfigText)) return { baseSystemConfigPath: systemConfigPath, inheritsHostSigningConfig: false };
  return { baseSystemConfigPath: includedSystemConfigPath(systemConfigText), inheritsHostSigningConfig: true };
}

async function writePrivateFile(filePath: string, text: string): Promise<void> {
  const stagedPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(stagedPath, text, { mode: 0o600 });
  await fs.rename(stagedPath, filePath);
}

function gitExitCodeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function createHostSigningKeyStore({ folder }: { folder: string }): HostSigningKeyStore {
  const privateKeyPath = path.join(folder, PRIVATE_KEY_FILE_NAME);
  const publicKeyPath = `${privateKeyPath}.pub`;
  const systemConfigPath = path.join(folder, SYSTEM_CONFIG_FILE_NAME);
  const identityConfigPath = path.join(folder, IDENTITY_CONFIG_FILE_NAME);
  const allowedSignersPath = path.join(folder, ALLOWED_SIGNERS_FILE_NAME);
  let earlierRemoveRecording: Promise<void> | null = null;
  const recordPath = path.join(folder, RECORD_FILE_NAME);
  let systemConfigBase: Promise<SystemConfigBase> | null = null;

  async function read(): Promise<HostSigningKey | null> {
    const privateKeyStats = await fs.stat(privateKeyPath).catch(() => null);
    if (!privateKeyStats?.isFile()) return null;
    return hostSigningKeyOf(await fs.readFile(publicKeyPath, 'utf8').catch(() => ''));
  }

  async function setup(): Promise<HostSigningKey> {
    await earlierRemoveRecorded();
    const existing = await read();
    if (existing) return existing;
    await fs.mkdir(folder, { recursive: true, mode: KEY_FOLDER_MODE });
    await fs.chmod(folder, KEY_FOLDER_MODE);
    const stagingFolder = await fs.mkdtemp(path.join(folder, 'staging-'));
    try {
      const stagedKeyPath = path.join(stagingFolder, PRIVATE_KEY_FILE_NAME);
      await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', KEY_COMMENT, '-f', stagedKeyPath], { timeout: KEYGEN_TIMEOUT_MS, encoding: 'utf8' });
      await fs.rename(`${stagedKeyPath}.pub`, publicKeyPath);
      await fs.rename(stagedKeyPath, privateKeyPath);
    } finally {
      await fs.rm(stagingFolder, { recursive: true, force: true });
    }
    const created = await read();
    if (!created) throw new Error(`ssh-keygen left no readable signing key in ${folder}`);
    return created;
  }

  async function remove(): Promise<void> {
    const { identity } = await readRecord().catch(() => NO_REGISTRATION);
    await fs.rm(systemConfigPath, { force: true });
    await fs.rm(allowedSignersPath, { force: true });
    await fs.rm(privateKeyPath, { force: true });
    await fs.rm(publicKeyPath, { force: true });
    await writeRecord({ github: null, identity, isSwitchedOff: true });
  }

  async function writePrivateFileIfChanged(filePath: string, text: string): Promise<void> {
    const current = await fs.readFile(filePath, 'utf8').catch(() => null);
    if (current === text) return;
    await writePrivateFile(filePath, text);
  }

  async function recordRemoveOfAnEarlierRelease(): Promise<void> {
    const folderStats = await fs.stat(folder).catch(() => null);
    if (folderStats === null || await read() !== null) return;
    const recordText = await fs.readFile(recordPath, 'utf8').catch(() => null);
    if (recordText !== null) return;
    await writePrivateFile(recordPath, `${JSON.stringify({ ...NO_REGISTRATION, isSwitchedOff: true })}\n`);
  }

  function earlierRemoveRecorded(): Promise<void> {
    earlierRemoveRecording ??= recordRemoveOfAnEarlierRelease();
    return earlierRemoveRecording;
  }

  async function readRecord(): Promise<CommitSigningRecord> {
    await earlierRemoveRecorded();
    const recordText = await fs.readFile(recordPath, 'utf8').catch(() => null);
    if (recordText === null) return NO_REGISTRATION;
    const parsed = CommitSigningRecord.safeParse(JSON.parse(recordText));
    if (!parsed.success) throw new Error(`${recordPath} is not a commit signing record: ${parsed.error.message}`);
    return parsed.data;
  }

  async function writeRecord(record: CommitSigningRecord): Promise<void> {
    await earlierRemoveRecorded();
    await fs.mkdir(folder, { recursive: true, mode: KEY_FOLDER_MODE });
    await writePrivateFile(recordPath, `${JSON.stringify(CommitSigningRecord.parse(record))}\n`);
  }

  async function projectSetsOwnSigning(cwd: string, base: SystemConfigBase): Promise<boolean> {
    const baseSystemEnv = hostSigningGitEnv({ systemConfigPath, baseSystemConfigPath: base.baseSystemConfigPath, usesHostConfig: false, inheritsHostSigningConfig: true });
    const ownSigning = await runGit(['config', '--get-regexp', OWN_SIGNING_SETTINGS_PATTERN], { cwd, env: baseSystemEnv });
    return ownSigning.ok || gitExitCodeOf(ownSigning.error) !== GIT_CONFIG_NO_MATCH_EXIT_CODE;
  }

  async function gitEnvFor(cwd: string): Promise<Record<string, string>> {
    systemConfigBase ??= discoverSystemConfigBase();
    const base = await systemConfigBase;
    const held = await read();
    const { identity } = await readRecord().catch(() => NO_REGISTRATION);
    const signingKey = held !== null && !await projectSetsOwnSigning(cwd, base) ? held : null;
    const hostConfigPath = signingKey ? systemConfigPath : identityConfigPath;
    const usesHostConfig = signingKey !== null || identity !== null;
    if (signingKey) await writePrivateFileIfChanged(allowedSignersPath, allowedSignersText({ principal: identity?.email ?? KEY_COMMENT, publicKeyText: signingKey.publicKeyText }));
    if (usesHostConfig) {
      await fs.mkdir(folder, { recursive: true, mode: KEY_FOLDER_MODE });
      await writePrivateFileIfChanged(hostConfigPath, hostGitConfigText({
        signing: signingKey ? { publicKeyText: signingKey.publicKeyText, allowedSignersPath } : null,
        identity,
        baseSystemConfigPath: base.baseSystemConfigPath,
      }));
    }
    return hostSigningGitEnv({ systemConfigPath: hostConfigPath, baseSystemConfigPath: base.baseSystemConfigPath, usesHostConfig, inheritsHostSigningConfig: base.inheritsHostSigningConfig });
  }

  async function signIfHeld({ publicKey, namespace, payload }: { publicKey: SshPublicKey; namespace: string; payload: Buffer }): Promise<SignOutcome | null> {
    const held = await read();
    if (!held || !isSameSshKey(held.publicKey, publicKey)) return null;
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-sign-'));
    try {
      const payloadPath = path.join(workDir, 'payload');
      await fs.writeFile(payloadPath, payload, { mode: 0o600 });
      await execFileAsync('ssh-keygen', ['-Y', 'sign', '-n', namespace, '-f', privateKeyPath, payloadPath], { timeout: SIGNING_TIMEOUT_MS, encoding: 'utf8' });
      return { ok: true, signature: await fs.readFile(`${payloadPath}.sig`, 'utf8') };
    } catch (error) {
      const stderr = (error as { stderr?: unknown } | null)?.stderr;
      return { ok: false, error: `ssh-keygen could not sign with the host key: ${typeof stderr === 'string' && stderr.trim() ? stderr.trim() : errorMessage(error)}` };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  return { read, setup, remove, gitEnvFor, readRecord, writeRecord, signIfHeld };
}

interface GithubAnswer {
  status: number;
  body: unknown;
}

interface CommitSigning {
  act: (action: CommitSigningAction) => Promise<CommitSigningStatus>;
  prepareHost: () => Promise<boolean>;
  disconnectGithub: <T>(disconnect: () => Promise<T>) => Promise<T>;
}

type GithubAccess = { kind: 'granted'; grant: GithubUserGrant } | { kind: 'none'; reason: string } | { kind: 'unknown' };

const GITHUB_STATES_WITHOUT_ACCESS: ReadonlySet<GithubConnection['state']> = new Set(['unavailable', 'disconnected', 'awaiting-code', 'needs-install', 'reconnect-needed']);
const UNREADABLE_ACCESS_TEXT = 'Glimmervoid could not read the GitHub connection, so the key on GitHub was left in place. Try again in a minute.';

function githubMessageOf(body: unknown): string | null {
  const message = (body as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message.slice(0, 200) : null;
}

function byHandNotice(login: string): string {
  return `Glimmervoid has no GitHub access for ${login}: delete the key named "${GITHUB_KEY_TITLE}" at github.com/settings/keys.`;
}

function createCommitSigning({ store, githubUserCredential, githubConnectionState, githubApiUrl = GITHUB_API_URL, fetchImpl = fetch, log = console }: {
  store: HostSigningKeyStore;
  githubUserCredential: () => Promise<GithubUserGrant | null>;
  githubConnectionState: () => Promise<GithubConnection | null>;
  githubApiUrl?: string;
  fetchImpl?: typeof fetch;
  log?: Pick<Console, 'warn'>;
}): CommitSigning {
  let actionChain: Promise<unknown> = Promise.resolve();
  let pendingProblem: string | null = null;

  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = actionChain.then(work, work);
    actionChain = next.catch(() => {});
    return next;
  }

  async function connectedGrant(): Promise<GithubUserGrant | null> {
    return githubUserCredential().catch((error: unknown) => {
      log.warn(`[commit-signing] could not read the GitHub connection: ${errorMessage(error)}`);
      return null;
    });
  }

  async function githubAccess(): Promise<GithubAccess> {
    const grant = await connectedGrant();
    if (grant) return { kind: 'granted', grant };
    const connection = await githubConnectionState().catch(() => null);
    if (connection && GITHUB_STATES_WITHOUT_ACCESS.has(connection.state)) return { kind: 'none', reason: connection.state };
    return { kind: 'unknown' };
  }

  async function githubRequest(grant: GithubUserGrant, method: string, requestPath: string, body?: unknown): Promise<GithubAnswer> {
    const response = await fetchImpl(`${githubApiUrl}${requestPath}`, {
      method,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${grant.token}`, 'X-GitHub-Api-Version': GITHUB_API_VERSION, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    const isJson = (response.headers.get('content-type') ?? '').includes('json');
    const text = await response.text();
    return { status: response.status, body: isJson && text !== '' ? JSON.parse(text) : null };
  }

  async function readableRecord(): Promise<{ record: CommitSigningRecord; problem: string | null }> {
    return store.readRecord().then((record) => ({ record, problem: null }), (error: unknown) => ({ record: NO_REGISTRATION, problem: errorMessage(error) }));
  }

  async function statusWith(problem: string | null): Promise<CommitSigningStatus> {
    const [hostKey, readable, grant] = await Promise.all([store.read(), readableRecord(), connectedGrant()]);
    const shownProblem = [problem, readable.problem, pendingProblem].filter((line) => line !== null).join(' ') || null;
    pendingProblem = null;
    return commitSigningStatusOf({ hostKey, record: readable.record, connectedLogin: grant?.login ?? null, problem: shownProblem });
  }

  async function githubKeyIdsMatching(grant: GithubUserGrant, held: HostSigningKey): Promise<number[]> {
    const listing = await githubRequest(grant, 'GET', '/user/ssh_signing_keys?per_page=100');
    if (listing.status !== 200) throw new Error(githubRefusalText('list', listing.status, githubMessageOf(listing.body)));
    const keys = GithubSigningKeyList.parse(listing.body);
    return keys.filter((listed) => {
      const listedKey = parseSshPublicKey(listed.key);
      return listedKey !== null && isSameSshKey(listedKey, held.publicKey);
    }).map((listed) => listed.id);
  }

  async function register(): Promise<string | null> {
    const held = await store.read();
    if (!held) return 'Set up a signing key first.';
    const grant = await connectedGrant();
    if (!grant) return 'Connect GitHub to register the key, or add it on GitHub by hand.';
    const created = await githubRequest(grant, 'POST', '/user/ssh_signing_keys', { title: GITHUB_KEY_TITLE, key: held.publicKeyText });
    const createdKey = created.status === 201 ? GithubSigningKeyCreated.safeParse(created.body) : null;
    const keyId = createdKey?.success ? createdKey.data.id : created.status === 422 ? (await githubKeyIdsMatching(grant, held))[0] ?? null : null;
    if (keyId === null) return githubRefusalText('register', created.status, githubMessageOf(created.body));
    const { record } = await readableRecord();
    await store.writeRecord({ ...record, github: { login: grant.login, keyId } });
    return null;
  }

  async function deleteEveryCopyOnGithub(grant: GithubUserGrant, record: CommitSigningRecord): Promise<void> {
    const held = await store.read();
    const matchingIds = held ? await githubKeyIdsMatching(grant, held) : [];
    const recordedId = record.github?.login === grant.login ? record.github.keyId : null;
    const keyIds = new Set(recordedId === null ? matchingIds : [...matchingIds, recordedId]);
    for (const keyId of keyIds) {
      const deleted = await githubRequest(grant, 'DELETE', `/user/ssh_signing_keys/${keyId}`);
      if (deleted.status !== 204 && deleted.status !== 404) throw new Error(githubRefusalText('delete', deleted.status, githubMessageOf(deleted.body)));
    }
  }

  async function removeFromGithub(record: CommitSigningRecord): Promise<string | null> {
    const access = await githubAccess();
    if (access.kind === 'unknown') throw new Error(UNREADABLE_ACCESS_TEXT);
    if (access.kind === 'none') return record.github ? byHandNotice(record.github.login) : null;
    await deleteEveryCopyOnGithub(access.grant, record);
    if (record.github && record.github.login !== access.grant.login) return byHandNotice(record.github.login);
    return null;
  }

  async function remove(): Promise<string | null> {
    const { record } = await readableRecord();
    const notice = await removeFromGithub(record);
    await store.remove();
    return notice;
  }

  async function setUp(): Promise<string | null> {
    const { record } = await readableRecord();
    await store.writeRecord({ ...record, isSwitchedOff: false });
    await store.setup();
    if (!await connectedGrant()) return null;
    return register();
  }

  const problemOfAction: Record<CommitSigningAction, () => Promise<string | null>> = { read: async () => null, setup: setUp, register, remove };

  async function act(action: CommitSigningAction): Promise<CommitSigningStatus> {
    return serialized(async () => {
      try {
        return await statusWith(await problemOfAction[action]());
      } catch (error) {
        return statusWith(errorMessage(error));
      }
    });
  }

  async function forgetGithubKey(): Promise<void> {
    const { record } = await readableRecord();
    if (!record.github) return;
    const grant = await connectedGrant();
    if (!grant || grant.login !== record.github.login) throw new Error(byHandNotice(record.github.login));
    await deleteEveryCopyOnGithub(grant, record);
    await store.writeRecord({ ...record, github: null });
  }

  async function rememberGithubIdentity(grant: GithubUserGrant): Promise<void> {
    const answered = await githubRequest(grant, 'GET', '/user');
    if (answered.status !== 200) throw new Error(`GitHub did not say who is connected (HTTP ${answered.status}).`);
    const record = await store.readRecord();
    await store.writeRecord({ ...record, identity: githubNoreplyIdentity(GithubUser.parse(answered.body)) });
  }

  async function signingProblemAfterConnect(): Promise<string | null> {
    const record = await store.readRecord();
    if (record.isSwitchedOff || record.github) return null;
    return setUp();
  }

  function prepareHost(): Promise<boolean> {
    return serialized(async () => {
      const grant = await connectedGrant();
      if (!grant) return false;
      const identityProblem = await rememberGithubIdentity(grant).then(() => null, (error: unknown) => `Glimmervoid could not read the git identity from GitHub: ${errorMessage(error)}`);
      const signingProblem = await signingProblemAfterConnect().catch((error: unknown) => errorMessage(error));
      const problems = [identityProblem, signingProblem].filter((line) => line !== null);
      if (problems.length === 0) return true;
      pendingProblem = problems.join(' ');
      log.warn(`[commit-signing] ${pendingProblem}`);
      return identityProblem === null;
    });
  }

  async function forgetGithubIdentity(): Promise<void> {
    const record = await store.readRecord();
    if (record.identity) await store.writeRecord({ ...record, identity: null });
  }

  function disconnectGithub<T>(disconnect: () => Promise<T>): Promise<T> {
    return serialized(async () => {
      await forgetGithubKey().catch((error: unknown) => {
        pendingProblem = `Disconnect left the signing key on GitHub: ${errorMessage(error)}`;
        log.warn(`[commit-signing] ${pendingProblem}`);
      });
      await forgetGithubIdentity().catch((error: unknown) => log.warn(`[commit-signing] disconnect left the git identity in place: ${errorMessage(error)}`));
      return disconnect();
    });
  }

  return { act, disconnectGithub, prepareHost };
}

function followingGithubConnection(githubConnection: (action: GithubConnectionAction) => Promise<GithubConnection | null>, commitSigning: Pick<CommitSigning, 'disconnectGithub' | 'prepareHost'>): (action: GithubConnectionAction) => Promise<GithubConnection | null> {
  let preparedLogin: string | null = null;

  function prepareOnce(login: string): void {
    if (login === preparedLogin) return;
    preparedLogin = login;
    void commitSigning.prepareHost().then((didPrepare) => {
      if (!didPrepare && preparedLogin === login) preparedLogin = null;
    });
  }

  return async (action) => {
    if (action === 'disconnect') {
      preparedLogin = null;
      return commitSigning.disconnectGithub(() => githubConnection(action));
    }
    const connection = await githubConnection(action);
    if (connection?.state === 'connected') prepareOnce(connection.login);
    return connection;
  };
}

export { createCommitSigning, createHostSigningKeyStore, followingGithubConnection };
export type { CommitSigning, HostSigningKeyStore };
