import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RequestListener } from 'node:http';
import tls from 'node:tls';
import { runCommandSafely } from '../child-process-safe.ts';
import { resolveAdapter } from '../../session/adapters/index.ts';
import { runGit } from '../git/git-exec.ts';
import { writeTextAtomic } from '../json-file.ts';
import { configSiblingPath } from '../pairings-store.ts';
import { glimmervoidSecretPaths } from '../secrets/core/secret-files-core.ts';
import { isPathInside } from '../../shared/paths.ts';
import { errorMessage } from '../../shared/text.ts';
import type { PrepareSandbox, SandboxLaunchFacts } from '../../session/sessions.ts';
import type { SpawnEnv } from '../../session/core/spawn-env.ts';
import type { CredentialProxyRoute, GitRepositoryLayout, SealedHomeLink } from './core/sandbox-policy-core.ts';
import { SHORT_SOCKET_FOLDER_PREFIX, buildSrtSettings, ingressSocketPathIn, proxyTrustEnv, proxyTrustFilesIn, sandboxedCommand, seatbeltCommand, srtSettingsPathIn } from './core/sandbox-policy-core.ts';
import { CREDENTIALED_HOSTS, everyModelLoginEntry, isKeyringLoginAgent, modelHostsOf, withoutInheritedCredentials, modelLoginConfigFileFor, modelLoginFileFor, modelLoginHomeOf, sessionAgentHomeOf } from './core/credential-decider-core.ts';
import { PLACEHOLDER_TOKEN, placeholderEnv } from '../../session/core/agent-home-core.ts';
import { withoutGlimmervoidSecrets } from '../../session/core/spawn-env.ts';
import { clock } from '../../shared/clock.ts';
import { ANTIGRAVITY_TOKEN_FILE_SEGMENTS, antigravityPlaceholderLogin, sessionBusSocketPath } from './core/keyring-login-core.ts';
import type { KeyringRead } from './keyring-reader.ts';
import type { CredentialProxies, PlaceholderExpectation } from './credential-proxy.ts';

type SandboxLauncher = { kind: 'bubblewrap'; socatPath: string } | { kind: 'seatbelt'; seatbeltLauncherPath: string };

interface SandboxTools {
  nodePath: string;
  srtCliPath: string;
  launcher: SandboxLauncher;
}

interface SessionSandboxDependencies {
  glimmervoidHome: string;
  configPath: string;
  ingressRequestListener: RequestListener;
  listenIngressSocket: (options: { socketPath: string; ingressApp: RequestListener }) => Promise<{ close(): Promise<void> }>;
  getIngressPort: () => number | null;
  resolveTools: () => Promise<SandboxTools | { refusal: string }>;
  getExtraAllowedHosts: () => readonly string[];
  isWeakerNetworkIsolationOn: () => boolean;
  getAgentAccountFolders: () => readonly string[];
  credentialProxies: Pick<CredentialProxies, 'acquire' | 'expectPlaceholder'>;
  readKeyringLogin: (agent: string) => Promise<KeyringRead>;
  proxyCertificatePem: () => Promise<string>;
}

type HeldCredentialProxy = { route: CredentialProxyRoute; release: () => void; loginExpectation: PlaceholderExpectation | null };

async function realPathOrSame(filePath: string | null): Promise<string | null> {
  if (filePath === null) return null;
  return fsp.realpath(filePath).catch(() => filePath);
}

const KEYRING_LOGIN_FOLDER_MODE = 0o700;
const KEYRING_LOGIN_FILE_MODE = 0o600;
const PLACEHOLDER_NONCE_BYTES = 8;
const LOGIN_PROOF_TIMEOUT_MS = 60_000;
const AGENT_VERSION_TIMEOUT_MS = 10_000;

async function agentHomeInside(dependencies: SessionSandboxDependencies, facts: SandboxLaunchFacts): Promise<string | null> {
  const sessionHome = sessionAgentHomeOf(facts.agent, facts.env);
  const agentHomesRoot = await fsp.realpath(path.join(dependencies.glimmervoidHome, 'agent-homes')).catch(() => null);
  const realSessionHome = sessionHome === null ? null : await fsp.realpath(sessionHome).catch(() => null);
  if (agentHomesRoot === null || realSessionHome === null || !isPathInside(agentHomesRoot, realSessionHome, { allowEqual: false })) return null;
  return realSessionHome;
}

async function placeKeyringLogin(dependencies: SessionSandboxDependencies, facts: SandboxLaunchFacts): Promise<{ refusal: string } | { placedBearer: string | null }> {
  if (!isKeyringLoginAgent(facts.agent)) return { placedBearer: null };
  const sessionHome = await agentHomeInside(dependencies, facts);
  if (sessionHome === null) return { refusal: 'its HOME is not a Glimmervoid agent home, so no placeholder login can be placed there' };
  const login = await dependencies.readKeyringLogin(facts.agent);
  if ('refusal' in login) return login;
  const placedBearer = `${PLACEHOLDER_TOKEN}-${randomBytes(PLACEHOLDER_NONCE_BYTES).toString('hex')}`;
  const placed = antigravityPlaceholderLogin(login.secret, clock.nowMs(), placedBearer);
  if ('refusal' in placed) return placed;
  const loginFile = path.join(sessionHome, ...ANTIGRAVITY_TOKEN_FILE_SEGMENTS);
  await fsp.mkdir(path.dirname(loginFile), { recursive: true, mode: KEYRING_LOGIN_FOLDER_MODE });
  await writeTextAtomic(loginFile, placed.placeholder, { mode: KEYRING_LOGIN_FILE_MODE, enforceMode: true });
  return { placedBearer };
}

async function agentVersionOf(agentFile: string): Promise<string> {
  const run = await runCommandSafely(agentFile, ['--version'], { cwd: os.tmpdir(), env: withoutGlimmervoidSecrets(process.env), timeoutMs: AGENT_VERSION_TIMEOUT_MS, maxBufferBytes: 64 * 1024 }).catch(() => null);
  const version = run?.ok === true ? run.stdout.trim().split('\n')[0] : '';
  return version === '' ? 'of unknown version' : version;
}

function loginProofReason(agent: string, version: string): string {
  const label = resolveAdapter(agent)?.label ?? agent;
  const tokenPath = path.join('~', ...ANTIGRAVITY_TOKEN_FILE_SEGMENTS);
  return `${label} ${version} did not sign in with the stand-in login Glimmervoid placed at ${tokenPath} in its private home within ${LOGIN_PROOF_TIMEOUT_MS / 1000} s, so this release likely keeps its sign-in elsewhere. The session was stopped. Run it without the session sandbox, or update Glimmervoid for ${label} ${version}`;
}

function keyringUnreadableReason(agent: string): string {
  const label = resolveAdapter(agent)?.label ?? agent;
  return `Glimmervoid could not read your ${label} sign-in from the login keyring while the session signed in, so it had no login to pass on. The session was stopped. Unlock the keyring or sign in to ${label} again outside Glimmervoid, then restart the session`;
}

function loginProofOf(expectation: PlaceholderExpectation | null, facts: SandboxLaunchFacts): { awaitLoginProof?: () => Promise<string | null> } {
  if (expectation === null) return {};
  return {
    awaitLoginProof: async () => {
      let timer: NodeJS.Timeout | null = null;
      const timedOut = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), LOGIN_PROOF_TIMEOUT_MS); });
      const outcome = await Promise.race([expectation.outcome, timedOut]);
      if (timer !== null) clearTimeout(timer);
      if (outcome === 'seen' || outcome === 'cancelled') return null;
      expectation.cancel();
      if (outcome === 'login-unreadable') return keyringUnreadableReason(facts.agent);
      return loginProofReason(facts.agent, await agentVersionOf(facts.file));
    },
  };
}

const ABSTRACT_SOCKET_MARK = '\0';

function hostSessionBusSocket(): string {
  return sessionBusSocketPath(process.env.DBUS_SESSION_BUS_ADDRESS, os.userInfo().uid);
}

function sessionBusRefusal(dependencies: SessionSandboxDependencies, facts: SandboxLaunchFacts): { refusal: string } | null {
  const isBusAbstract = hostSessionBusSocket().startsWith(ABSTRACT_SOCKET_MARK);
  if (!isKeyringLoginAgent(facts.agent) || !isBusAbstract || !dependencies.isWeakerNetworkIsolationOn()) return null;
  return { refusal: 'the session bus is an abstract socket, which weaker network isolation leaves reachable from the sandbox, so the keyring login would be exposed' };
}

function sessionBusFilesToHide(): string[] {
  const busSocket = hostSessionBusSocket();
  return busSocket.startsWith(ABSTRACT_SOCKET_MARK) ? [] : [busSocket];
}

async function holdCredentialProxy(dependencies: SessionSandboxDependencies, facts: SandboxLaunchFacts): Promise<HeldCredentialProxy | { refusal: string }> {
  const busRefusal = sessionBusRefusal(dependencies, facts);
  if (busRefusal !== null) return { refusal: `A sandboxed ${facts.agent} session cannot start: ${busRefusal.refusal}.` };
  const keyringLogin = await placeKeyringLogin(dependencies, facts);
  if ('refusal' in keyringLogin) return { refusal: `A sandboxed ${facts.agent} session cannot start: ${keyringLogin.refusal}.` };
  const loginConfigFile = modelLoginConfigFileFor(facts.agent, process.env, os.homedir(), facts.accountFolder);
  const loginConfigText = loginConfigFile === null ? null : await fsp.readFile(loginConfigFile, 'utf8').catch(() => null);
  const login = modelLoginFileFor(facts.agent, process.env, os.homedir(), facts.accountFolder, loginConfigText, facts.env);
  if ('refusal' in login) return { refusal: `A sandboxed ${facts.agent} session cannot start: ${login.refusal}.` };
  const loginFile = await realPathOrSame(login.loginFile);
  const acquisition = await dependencies.credentialProxies.acquire({ agent: facts.agent, loginFile });
  if (!acquisition.ok) return { refusal: acquisition.reason };
  const loginExpectation = keyringLogin.placedBearer === null ? null : dependencies.credentialProxies.expectPlaceholder(keyringLogin.placedBearer);
  const release = () => {
    loginExpectation?.cancel();
    acquisition.release();
  };
  return { route: { socketPath: acquisition.socketPath, proxiesFolder: acquisition.proxiesFolder, hosts: CREDENTIALED_HOSTS }, release, loginExpectation };
}

async function childFoldersOf(folder: string): Promise<string[]> {
  const entries = await fsp.readdir(folder, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(folder, entry.name));
}

async function existingRealPaths(filePaths: readonly string[]): Promise<string[]> {
  const realPaths = await Promise.all(filePaths.map((filePath) => fsp.realpath(filePath).catch(() => null)));
  return [...new Set(realPaths.filter((realPath) => realPath !== null))];
}

async function modelLoginEntriesOf(dependencies: SessionSandboxDependencies, sessionAccountFolder: string | null): Promise<string[]> {
  const ownedAccountFolders = await childFoldersOf(configSiblingPath(dependencies.configPath, 'agent-accounts'));
  const accountFolders = [...new Set([...ownedAccountFolders, ...dependencies.getAgentAccountFolders(), ...(sessionAccountFolder === null ? [] : [sessionAccountFolder])])];
  return everyModelLoginEntry(process.env, os.homedir(), accountFolders);
}

async function canonicalPathOf(entryPath: string): Promise<string> {
  const folder = await fsp.realpath(path.dirname(entryPath)).catch(() => path.dirname(entryPath));
  return path.join(folder, path.basename(entryPath));
}

async function symlinksIn(folder: string): Promise<string[]> {
  const entries = await fsp.readdir(folder, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isSymbolicLink()).map((entry) => path.join(folder, entry.name));
}

async function linkedPathsIn(generatedHome: string): Promise<string[]> {
  const entries = await fsp.readdir(generatedHome, { withFileTypes: true }).catch(() => []);
  const childFolders = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(generatedHome, entry.name));
  const linkPaths = [...await symlinksIn(generatedHome), ...(await Promise.all(childFolders.map(symlinksIn))).flat()];
  const linkTexts = await Promise.all(linkPaths.map(async (linkPath) => {
    const linkText = await fsp.readlink(linkPath).catch(() => null);
    return linkText === null ? null : canonicalPathOf(path.resolve(path.dirname(linkPath), linkText));
  }));
  return linkTexts.filter((linkedPath) => linkedPath !== null);
}

function topEntryWithin(loginHome: string, linkedPath: string): string | null {
  if (!isPathInside(loginHome, linkedPath, { allowEqual: false })) return null;
  return path.join(loginHome, path.relative(loginHome, linkedPath).split(path.sep)[0]);
}

async function carveOutsFor(loginHomes: readonly string[], linkedPaths: readonly string[], loginEntries: readonly string[]): Promise<string[]> {
  const topEntries = [...new Set(linkedPaths.flatMap((linkedPath) => loginHomes.map((loginHome) => topEntryWithin(loginHome, linkedPath))).filter((entry) => entry !== null))];
  const holdsLogin = (entry: string) => loginEntries.some((loginEntry) => isPathInside(entry, loginEntry) || isPathInside(loginEntry, entry));
  const carvable = await Promise.all(topEntries.filter((entry) => !holdsLogin(entry)).map(async (entry) => {
    const entryStat = await fsp.lstat(entry).catch(() => null);
    return entryStat === null || entryStat.isSymbolicLink() ? null : entry;
  }));
  return carvable.filter((entry) => entry !== null);
}

async function restorableLinkOf(folder: string, linkPath: string, hiddenEntries: ReadonlySet<string>): Promise<SealedHomeLink[]> {
  const linkRealPath = await fsp.realpath(linkPath).catch(() => null);
  if (hiddenEntries.has(linkPath) || (linkRealPath !== null && hiddenEntries.has(linkRealPath))) return [];
  const linkText = await fsp.readlink(linkPath).catch(() => null);
  return linkText === null ? [] : [{ linkPath, target: path.resolve(folder, linkText) }];
}

async function linksIn(folder: string, hiddenEntries: ReadonlySet<string>): Promise<SealedHomeLink[]> {
  const linkPaths = await symlinksIn(folder);
  return (await Promise.all(linkPaths.map((linkPath) => restorableLinkOf(folder, linkPath, hiddenEntries)))).flat();
}

interface SealedLoginHomes {
  sealedLoginHomes: string[];
  sealedLoginHomeCarveOuts: string[];
  restoredLinks: SealedHomeLink[];
}

async function sealedLoginHomesFor(dependencies: SessionSandboxDependencies, facts: SandboxLaunchFacts, loginEntries: readonly string[], hiddenEntries: readonly string[]): Promise<SealedLoginHomes> {
  const unsealed = { sealedLoginHomes: [], sealedLoginHomeCarveOuts: [], restoredLinks: [] };
  const sessionHome = sessionAgentHomeOf(facts.agent, facts.env);
  const realSessionHome = sessionHome === null ? null : await fsp.realpath(sessionHome).catch(() => null);
  const generatedHomesRoot = await fsp.realpath(path.join(dependencies.glimmervoidHome, 'agent-homes')).catch(() => null);
  if (realSessionHome === null || generatedHomesRoot === null || !isPathInside(generatedHomesRoot, realSessionHome, { allowEqual: false })) return unsealed;
  const loginHomePaths = [modelLoginHomeOf(facts.agent, process.env, os.homedir()), facts.accountFolder].filter((folder) => folder !== null);
  const loginHomes = await existingRealPaths(loginHomePaths);
  const canonicalLoginEntries = await Promise.all(loginEntries.map(canonicalPathOf));
  const sealedLoginHomeCarveOuts = await carveOutsFor(loginHomes, await linkedPathsIn(realSessionHome), [...canonicalLoginEntries, ...hiddenEntries]);
  const hiddenEntrySet = new Set(hiddenEntries);
  const restoredLinks = (await Promise.all(loginHomes.map((loginHome) => linksIn(loginHome, hiddenEntrySet)))).flat();
  const spelledLoginHomes = (await Promise.all(loginHomePaths.map(async (loginHomePath) => (await fsp.stat(loginHomePath).catch(() => null)) === null || loginHomes.includes(path.resolve(loginHomePath)) ? null : path.resolve(loginHomePath)))).filter((loginHomePath) => loginHomePath !== null);
  return { sealedLoginHomes: [...loginHomes, ...spelledLoginHomes], sealedLoginHomeCarveOuts, restoredLinks };
}

const PEM_CERTIFICATE_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

async function certificatesIn(filePath: string | undefined): Promise<string[]> {
  if (!filePath) return [];
  const text = await fsp.readFile(filePath, 'utf8').catch(() => '');
  return text.match(PEM_CERTIFICATE_PATTERN) ?? [];
}

async function writeProxyTrustFiles(sessionTempFolder: string, proxyCertificatePem: string, env: SpawnEnv): Promise<Record<string, string>> {
  const trustFiles = proxyTrustFilesIn(sessionTempFolder);
  const inheritedExtraCertificates = await certificatesIn(env.NODE_EXTRA_CA_CERTS);
  const inheritedBundleCertificates = await certificatesIn(env.SSL_CERT_FILE);
  const trusted = [...new Set([proxyCertificatePem.trim(), ...tls.rootCertificates, ...tls.getCACertificates('system'), ...inheritedBundleCertificates, ...inheritedExtraCertificates].map((certificate) => certificate.trim()))];
  await writeTextAtomic(trustFiles.proxyCertificatePath, `${[proxyCertificatePem.trim(), ...inheritedExtraCertificates].join('\n')}\n`);
  await writeTextAtomic(trustFiles.trustBundlePath, `${trusted.join('\n')}\n`);
  return proxyTrustEnv(trustFiles);
}

async function dotGitFileIn(repositoryRoot: string): Promise<string | null> {
  const dotGitPath = path.join(repositoryRoot, '.git');
  const dotGit = await fsp.lstat(dotGitPath).catch(() => null);
  return dotGit !== null && !dotGit.isDirectory() ? dotGitPath : null;
}

async function gitRepositoryAt(folder: string): Promise<GitRepositoryLayout | null> {
  const answer = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir', '--absolute-git-dir', '--show-toplevel'], { cwd: folder });
  if (!answer.ok) return null;
  const [commonDir, gitDir, repositoryRoot] = answer.out.split('\n');
  if (!commonDir || !gitDir || !repositoryRoot) return null;
  return { commonDir, gitDir, dotGitFile: await dotGitFileIn(repositoryRoot) };
}

async function gitRepositoriesUnder(worktree: string): Promise<GitRepositoryLayout[]> {
  const ownRepository = await gitRepositoryAt(worktree);
  if (ownRepository !== null) return [ownRepository];
  const entries = await fsp.readdir(worktree, { withFileTypes: true }).catch(() => []);
  const childRepositories = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => gitRepositoryAt(path.join(worktree, entry.name))));
  return childRepositories.filter((repository) => repository !== null);
}

async function ownSessionHomeOf(facts: SandboxLaunchFacts): Promise<string[]> {
  const sessionHome = sessionAgentHomeOf(facts.agent, facts.env);
  if (sessionHome === null) return [];
  return [...new Set([sessionHome, ...await existingRealPaths([sessionHome])])];
}

function readableFilesIn(env: SpawnEnv): string[] {
  const systemGitConfig = env.GIT_CONFIG_SYSTEM;
  return systemGitConfig ? [systemGitConfig] : [];
}

function sessionSandboxFor(dependencies: SessionSandboxDependencies, sessionTempFolder: string, hiddenFolders: readonly string[]): PrepareSandbox {
  return async (facts: SandboxLaunchFacts) => {
    const ingressPort = dependencies.getIngressPort();
    if (ingressPort === null) return { ok: false, reason: 'the agent endpoint is not listening yet', code: 'SANDBOX_ENDPOINT_NOT_LISTENING' };
    const tools = await dependencies.resolveTools();
    if ('refusal' in tools) return { ok: false, reason: tools.refusal, code: 'SANDBOX_TOOLS_MISSING' };
    const credentialProxy = await holdCredentialProxy(dependencies, facts);
    if ('refusal' in credentialProxy) return { ok: false, reason: credentialProxy.refusal, code: 'SANDBOX_CREDENTIAL_PROXY_FAILED' };
    const prepared = await launchWithin(dependencies, sessionTempFolder, hiddenFolders, facts, tools, ingressPort, credentialProxy)
      .catch((error: unknown) => ({ ok: false as const, reason: errorMessage(error), code: 'SANDBOX_LAUNCH_FAILED' as const }));
    if (!prepared.ok) credentialProxy.release();
    return prepared;
  };
}

async function launchWithin(dependencies: SessionSandboxDependencies, sessionTempFolder: string, hiddenFolders: readonly string[], facts: SandboxLaunchFacts, tools: SandboxTools, ingressPort: number, credentialProxy: HeldCredentialProxy): ReturnType<PrepareSandbox> {
  const trustEnv = await writeProxyTrustFiles(sessionTempFolder, await dependencies.proxyCertificatePem(), facts.env);
  const loginEntries = await modelLoginEntriesOf(dependencies, facts.accountFolder);
  const hiddenLoginEntries = await existingRealPaths(loginEntries);
  const { restoredLinks, ...sealedLoginHomes } = await sealedLoginHomesFor(dependencies, facts, loginEntries, hiddenLoginEntries);
  const settings = buildSrtSettings({
    homeDir: os.homedir(),
    glimmervoidHome: dependencies.glimmervoidHome,
    configFolder: path.dirname(dependencies.configPath),
    secretPaths: [...glimmervoidSecretPaths({ glimmervoidHome: dependencies.glimmervoidHome, configPath: dependencies.configPath }), ...hiddenLoginEntries, ...sessionBusFilesToHide()],
    agent: facts.agent,
    accountFolder: facts.accountFolder,
    ...sealedLoginHomes,
    userId: os.userInfo().uid,
    worktree: facts.cwd,
    gitRepositories: await gitRepositoriesUnder(facts.cwd),
    sessionTempFolder,
    readableFiles: readableFilesIn(facts.env),
    extraAllowedHosts: [...new Set([...dependencies.getExtraAllowedHosts(), ...modelHostsOf(facts.agent)])],
    enableWeakerNetworkIsolation: dependencies.isWeakerNetworkIsolationOn(),
    credentialProxy: credentialProxy.route,
    hiddenFolders: [...new Set([...hiddenFolders, ...await existingRealPaths(hiddenFolders)])],
    ownFolders: await ownSessionHomeOf(facts),
  });
  const settingsText = `${JSON.stringify(settings, null, 2)}\n`;
  const env = { ...withoutInheritedCredentials(facts.env, facts.launchSetEnvNames), ...trustEnv, ...placeholderEnv(facts.agent) };
  if (tools.launcher.kind === 'seatbelt') {
    const launcherFolder = await fsp.mkdtemp(SHORT_SOCKET_FOLDER_PREFIX);
    const removeLauncherFolder = () => fsp.rm(launcherFolder, { recursive: true, force: true });
    const launcherSettingsPath = srtSettingsPathIn(launcherFolder);
    const written = await writeTextAtomic(launcherSettingsPath, settingsText).then(() => null, (error: unknown) => ({ refusal: `the sandbox settings could not be written: ${errorMessage(error)}` }));
    if (written !== null) {
      await removeLauncherFolder();
      return { ok: false, reason: written.refusal, code: 'SANDBOX_SETTINGS_UNWRITABLE' };
    }
    const command = seatbeltCommand({ nodePath: tools.nodePath, seatbeltLauncherPath: tools.launcher.seatbeltLauncherPath, settingsPath: launcherSettingsPath, ingressPort, agentTempFolder: sessionTempFolder, restoredLinks, file: facts.file, args: facts.args });
    return {
      ok: true,
      launch: {
        ...command,
        ...loginProofOf(credentialProxy.loginExpectation, facts),
        env: { ...env, TMPDIR: launcherFolder },
        dispose: async () => {
          credentialProxy.release();
          await removeLauncherFolder();
        },
      },
    };
  }
  const settingsPath = srtSettingsPathIn(sessionTempFolder);
  await writeTextAtomic(settingsPath, settingsText);
  const socketFolder = await fsp.mkdtemp(SHORT_SOCKET_FOLDER_PREFIX);
  const ingressSocketPath = ingressSocketPathIn(socketFolder);
  const removeSocketFolder = () => fsp.rm(socketFolder, { recursive: true, force: true });
  const ingressSocket = await dependencies.listenIngressSocket({ socketPath: ingressSocketPath, ingressApp: dependencies.ingressRequestListener })
    .catch((error: unknown) => ({ refusal: `the session bridge could not listen: ${errorMessage(error)}` }));
  if ('refusal' in ingressSocket) {
    await removeSocketFolder();
    return { ok: false, reason: ingressSocket.refusal, code: 'SANDBOX_BRIDGE_LISTEN_FAILED' };
  }
  const command = sandboxedCommand({ nodePath: tools.nodePath, srtCliPath: tools.srtCliPath, socatPath: tools.launcher.socatPath, settingsPath, ingressPort, ingressSocketPath, agentTempFolder: sessionTempFolder, restoredLinks, file: facts.file, args: facts.args });
  return {
    ok: true,
    launch: {
      ...command,
      ...loginProofOf(credentialProxy.loginExpectation, facts),
      env: { ...env, TMPDIR: socketFolder },
      dispose: async () => {
        credentialProxy.release();
        await ingressSocket.close();
        await removeSocketFolder();
      },
    },
  };
}

export { sessionSandboxFor };
export type { SandboxLauncher, SandboxTools };
