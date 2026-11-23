import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RequestListener } from 'node:http';
import tls from 'node:tls';
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
import { CREDENTIALED_HOSTS, everyModelLoginEntry, withoutInheritedCredentials, modelLoginFileFor, modelLoginHomeOf, sessionAgentHomeOf } from './core/credential-decider-core.ts';
import { placeholderEnv } from '../../session/core/agent-home-core.ts';
import type { CredentialProxies } from './credential-proxy.ts';

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
  credentialProxies: Pick<CredentialProxies, 'acquire'>;
  proxyCertificatePem: () => Promise<string>;
}

type HeldCredentialProxy = { route: CredentialProxyRoute; release: () => void };

async function realPathOrSame(filePath: string | null): Promise<string | null> {
  if (filePath === null) return null;
  return fsp.realpath(filePath).catch(() => filePath);
}

async function holdCredentialProxy(dependencies: SessionSandboxDependencies, facts: SandboxLaunchFacts): Promise<HeldCredentialProxy | { refusal: string }> {
  const loginFile = await realPathOrSame(modelLoginFileFor(facts.agent, process.env, os.homedir(), facts.accountFolder));
  const acquisition = await dependencies.credentialProxies.acquire({ agent: facts.agent, loginFile });
  if (!acquisition.ok) return { refusal: acquisition.reason };
  return { route: { socketPath: acquisition.socketPath, proxiesFolder: acquisition.proxiesFolder, hosts: CREDENTIALED_HOSTS }, release: acquisition.release };
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
    if (ingressPort === null) return { ok: false, reason: 'the agent endpoint is not listening yet' };
    const tools = await dependencies.resolveTools();
    if ('refusal' in tools) return { ok: false, reason: tools.refusal };
    const credentialProxy = await holdCredentialProxy(dependencies, facts);
    if ('refusal' in credentialProxy) return { ok: false, reason: credentialProxy.refusal };
    const prepared = await launchWithin(dependencies, sessionTempFolder, hiddenFolders, facts, tools, ingressPort, credentialProxy)
      .catch((error: unknown) => ({ ok: false as const, reason: errorMessage(error) }));
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
    secretPaths: [...glimmervoidSecretPaths({ glimmervoidHome: dependencies.glimmervoidHome, configPath: dependencies.configPath }), ...hiddenLoginEntries],
    agent: facts.agent,
    accountFolder: facts.accountFolder,
    ...sealedLoginHomes,
    userId: os.userInfo().uid,
    worktree: facts.cwd,
    gitRepositories: await gitRepositoriesUnder(facts.cwd),
    sessionTempFolder,
    readableFiles: readableFilesIn(facts.env),
    extraAllowedHosts: dependencies.getExtraAllowedHosts(),
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
      return { ok: false, reason: written.refusal };
    }
    const command = seatbeltCommand({ nodePath: tools.nodePath, seatbeltLauncherPath: tools.launcher.seatbeltLauncherPath, settingsPath: launcherSettingsPath, ingressPort, agentTempFolder: sessionTempFolder, restoredLinks, file: facts.file, args: facts.args });
    return {
      ok: true,
      launch: {
        ...command,
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
    return { ok: false, reason: ingressSocket.refusal };
  }
  const command = sandboxedCommand({ nodePath: tools.nodePath, srtCliPath: tools.srtCliPath, socatPath: tools.launcher.socatPath, settingsPath, ingressPort, ingressSocketPath, agentTempFolder: sessionTempFolder, restoredLinks, file: facts.file, args: facts.args });
  return {
    ok: true,
    launch: {
      ...command,
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
