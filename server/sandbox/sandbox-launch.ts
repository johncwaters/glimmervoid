import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RequestListener } from 'node:http';
import tls from 'node:tls';
import { listenAgentIngressSocket } from '../backend/backend-http.ts';
import { runGit } from '../git/git-exec.ts';
import { writeTextAtomic } from '../json-file.ts';
import { configSiblingPath } from '../pairings-store.ts';
import { glimmervoidSecretPaths } from '../secrets/core/secret-files-core.ts';
import { errorMessage } from '../../shared/text.ts';
import type { PrepareSandbox, SandboxLaunchFacts } from '../../session/sessions.ts';
import type { SpawnEnv } from '../../session/core/spawn-env.ts';
import type { CredentialProxyRoute, GitRepositoryLayout } from './core/sandbox-policy-core.ts';
import { SHORT_SOCKET_FOLDER_PREFIX, buildSrtSettings, ingressSocketPathIn, proxyTrustEnv, proxyTrustFilesIn, sandboxedCommand, srtSettingsPathIn } from './core/sandbox-policy-core.ts';
import { CREDENTIALED_HOSTS, everyModelLoginEntry, modelLoginFileFor } from './core/credential-decider-core.ts';
import { placeholderEnv } from '../../session/core/agent-home-core.ts';
import type { CredentialProxies } from './credential-proxy.ts';

interface SandboxTools {
  nodePath: string;
  srtCliPath: string;
  socatPath: string;
}

interface SessionSandboxDependencies {
  glimmervoidHome: string;
  configPath: string;
  ingressRequestListener: RequestListener;
  getIngressPort: () => number | null;
  resolveTools: () => Promise<SandboxTools | { refusal: string }>;
  getExtraAllowedHosts: () => readonly string[];
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

async function modelLoginEntriesToHide(dependencies: SessionSandboxDependencies, sessionAccountFolder: string | null): Promise<string[]> {
  const ownedAccountFolders = await childFoldersOf(configSiblingPath(dependencies.configPath, 'agent-accounts'));
  const accountFolders = [...new Set([...ownedAccountFolders, ...dependencies.getAgentAccountFolders(), ...(sessionAccountFolder === null ? [] : [sessionAccountFolder])])];
  return existingRealPaths(everyModelLoginEntry(process.env, os.homedir(), accountFolders));
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

function readableFilesIn(env: SpawnEnv): string[] {
  const systemGitConfig = env.GIT_CONFIG_SYSTEM;
  return systemGitConfig ? [systemGitConfig] : [];
}

function sessionSandboxFor(dependencies: SessionSandboxDependencies, sessionTempFolder: string): PrepareSandbox {
  return async (facts: SandboxLaunchFacts) => {
    const ingressPort = dependencies.getIngressPort();
    if (ingressPort === null) return { ok: false, reason: 'the agent endpoint is not listening yet' };
    const tools = await dependencies.resolveTools();
    if ('refusal' in tools) return { ok: false, reason: tools.refusal };
    const credentialProxy = await holdCredentialProxy(dependencies, facts);
    if ('refusal' in credentialProxy) return { ok: false, reason: credentialProxy.refusal };
    const prepared = await launchWithin(dependencies, sessionTempFolder, facts, tools, ingressPort, credentialProxy)
      .catch((error: unknown) => ({ ok: false as const, reason: errorMessage(error) }));
    if (!prepared.ok) credentialProxy.release();
    return prepared;
  };
}

async function launchWithin(dependencies: SessionSandboxDependencies, sessionTempFolder: string, facts: SandboxLaunchFacts, tools: SandboxTools, ingressPort: number, credentialProxy: HeldCredentialProxy): ReturnType<PrepareSandbox> {
  const trustEnv = await writeProxyTrustFiles(sessionTempFolder, await dependencies.proxyCertificatePem(), facts.env);
  const settingsPath = srtSettingsPathIn(sessionTempFolder);
  const settings = buildSrtSettings({
    homeDir: os.homedir(),
    glimmervoidHome: dependencies.glimmervoidHome,
    configFolder: path.dirname(dependencies.configPath),
    secretPaths: [...glimmervoidSecretPaths({ glimmervoidHome: dependencies.glimmervoidHome, configPath: dependencies.configPath }), ...await modelLoginEntriesToHide(dependencies, facts.accountFolder)],
    agent: facts.agent,
    accountFolder: facts.accountFolder,
    userId: os.userInfo().uid,
    worktree: facts.cwd,
    gitRepositories: await gitRepositoriesUnder(facts.cwd),
    sessionTempFolder,
    readableFiles: readableFilesIn(facts.env),
    extraAllowedHosts: dependencies.getExtraAllowedHosts(),
    credentialProxy: credentialProxy.route,
  });
  await writeTextAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  const socketFolder = await fsp.mkdtemp(SHORT_SOCKET_FOLDER_PREFIX);
  const ingressSocketPath = ingressSocketPathIn(socketFolder);
  const removeSocketFolder = () => fsp.rm(socketFolder, { recursive: true, force: true });
  const ingressSocket = await listenAgentIngressSocket({ socketPath: ingressSocketPath, ingressApp: dependencies.ingressRequestListener })
    .catch((error: unknown) => ({ refusal: `the session bridge could not listen: ${errorMessage(error)}` }));
  if ('refusal' in ingressSocket) {
    await removeSocketFolder();
    return { ok: false, reason: ingressSocket.refusal };
  }
  const command = sandboxedCommand({ ...tools, settingsPath, ingressPort, ingressSocketPath, agentTempFolder: sessionTempFolder, file: facts.file, args: facts.args });
  return {
    ok: true,
    launch: {
      ...command,
      env: { ...facts.env, ...trustEnv, ...placeholderEnv(facts.agent), TMPDIR: socketFolder },
      dispose: async () => {
        credentialProxy.release();
        await ingressSocket.close();
        await removeSocketFolder();
      },
    },
  };
}

export { sessionSandboxFor };
export type { SandboxTools };
