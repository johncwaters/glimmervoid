import path from 'node:path';
import { isPathInside } from '../../../shared/paths.ts';

const INGRESS_SOCKET_NAME = 'ingress.sock';
const SRT_SETTINGS_NAME = 'srt.json';
const SHORT_SOCKET_FOLDER_PREFIX = '/tmp/glimmervoid-sandbox-';
const CREDENTIAL_PROXIES_FOLDER_PREFIX = '/tmp/glimmervoid-proxies-';
const TRUST_BUNDLE_NAME = 'trust-bundle.crt';
const PROXY_CERTIFICATE_NAME = 'proxy-ca.crt';
const TRUST_BUNDLE_ENV_NAMES: readonly string[] = Object.freeze(['SSL_CERT_FILE', 'GIT_SSL_CAINFO', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE']);

const DEFAULT_ALLOWED_HOSTS: readonly string[] = Object.freeze([
  'anthropic.com', '*.anthropic.com', 'claude.com', '*.claude.com', 'claude.ai', '*.claude.ai',
  'openai.com', '*.openai.com', 'chatgpt.com', '*.chatgpt.com',
  'openrouter.ai', '*.openrouter.ai', 'opencode.ai', '*.opencode.ai', 'models.dev',
  'kimi.com', '*.kimi.com', 'kimi.ai', '*.kimi.ai', 'moonshot.cn', '*.moonshot.cn',
  'github.com', '*.github.com', 'githubusercontent.com', '*.githubusercontent.com',
  'registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org',
  'crates.io', 'static.crates.io', 'index.crates.io', 'proxy.golang.org', 'sum.golang.org',
]);

const PRIVATE_NETWORK_RANGES: readonly string[] = Object.freeze(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fc00::/7']);

const GLIMMERVOID_HOME_READABLE_FOLDERS: readonly string[] = Object.freeze([
  'bin', 'runtime', 'sane-yolo', path.join('scratch', 'glimmervoid-hooks'), 'packs', 'pack-session-files', 'uploads', 'agent-homes',
]);

const GLIMMERVOID_HOME_WRITABLE_FOLDERS: readonly string[] = Object.freeze(['agent-homes']);

const HOME_UNREADABLE_PATHS: readonly string[] = Object.freeze(['.ssh', path.join('.config', 'gh'), '.git-credentials', '.netrc', '.docker']);

const SHARED_HOME_WRITABLE_PATHS: readonly string[] = Object.freeze(['.cache', '.npm', path.join('.local', 'state')]);

const AGENT_HOME_PATHS_BY_AGENT: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'claude-code': ['.claude', '.claude.json'],
  codex: ['.codex'],
  kimi: ['.kimi', '.kimi-code'],
  opencode: [path.join('.local', 'share', 'opencode')],
  pi: ['.pi'],
  gemini: ['.gemini'],
  qwen: ['.qwen'],
  copilot: ['.copilot'],
  grok: ['.grok'],
});

const PLATFORM_SOCKET_PATHS: readonly string[] = Object.freeze(['/var/run/docker.sock', '/run/docker.sock']);

interface GitRepositoryLayout {
  commonDir: string;
  gitDir: string;
  dotGitFile: string | null;
}

interface SandboxPolicyInput {
  homeDir: string;
  glimmervoidHome: string;
  configFolder: string;
  secretPaths: readonly string[];
  agent: string;
  accountFolder: string | null;
  sealedLoginHomes: readonly string[];
  sealedLoginHomeCarveOuts: readonly string[];
  userId: number;
  worktree: string;
  gitRepositories: readonly GitRepositoryLayout[];
  sessionTempFolder: string;
  readableFiles: readonly string[];
  extraAllowedHosts: readonly string[];
  enableWeakerNetworkIsolation: boolean;
  credentialProxy: CredentialProxyRoute | null;
  hiddenFolders: readonly string[];
  ownFolders: readonly string[];
}

interface SealedHomeLink {
  linkPath: string;
  target: string;
}

interface CredentialProxyRoute {
  socketPath: string;
  proxiesFolder: string;
  hosts: readonly string[];
}

interface SrtSettings {
  network: { allowedDomains: string[]; deniedDomains: string[]; deniedResolvedAddresses: string[]; allowAllUnixSockets: boolean; mitmProxy?: { socketPath: string; domains: string[] } };
  filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[]; denyWrite: string[] };
  enableWeakerNetworkIsolation: boolean;
}

interface SandboxedCommandInput {
  nodePath: string;
  srtCliPath: string;
  socatPath: string;
  settingsPath: string;
  ingressPort: number;
  ingressSocketPath: string;
  agentTempFolder: string;
  restoredLinks: readonly SealedHomeLink[];
  file: string;
  args: readonly string[];
}

const FORWARD_INGRESS_RESTORE_LINKS_THEN_EXEC = '"$1" "TCP-LISTEN:$2,bind=127.0.0.1,fork,reuseaddr" "UNIX-CONNECT:$3" & export TMPDIR="$4"; links="$5"; shift 5; while [ "$links" -gt 0 ]; do ln -s "$2" "$1" 2>/dev/null; shift 2; links=$((links - 1)); done; exec "$@"';

const LINKED_WORKTREE_POINTER_FILES: readonly string[] = Object.freeze(['commondir', 'gitdir', 'config.worktree']);

function gitMetadataDeniedWrites(repository: GitRepositoryLayout): string[] {
  const commonDirWrites = [path.join(repository.commonDir, 'hooks'), path.join(repository.commonDir, 'config')];
  const pointerWrites = repository.gitDir === repository.commonDir ? [] : LINKED_WORKTREE_POINTER_FILES.map((name) => path.join(repository.gitDir, name));
  return [...commonDirWrites, ...pointerWrites, ...(repository.dotGitFile === null ? [] : [repository.dotGitFile])];
}

function buildSrtSettings(input: SandboxPolicyInput): SrtSettings {
  const underHome = (relativePath: string) => path.join(input.homeDir, relativePath);
  const glimmervoidFolders = [...new Set([input.glimmervoidHome, input.configFolder])];
  const underGlimmervoidFolders = (relativePaths: readonly string[]) => glimmervoidFolders.flatMap((folder) => relativePaths.map((relativePath) => path.join(folder, relativePath)));
  const ownHomePaths = AGENT_HOME_PATHS_BY_AGENT[input.agent] ?? [];
  const otherAgentHomePaths = Object.entries(AGENT_HOME_PATHS_BY_AGENT).flatMap(([agent, homePaths]) => agent === input.agent ? [] : homePaths.filter((homePath) => !ownHomePaths.includes(homePath)));
  const isSealed = (folder: string) => input.sealedLoginHomes.some((sealedHome) => isPathInside(sealedHome, folder));
  const accountFolders = input.accountFolder === null || isSealed(input.accountFolder) ? [] : [input.accountFolder];
  const writableHomePaths = [...SHARED_HOME_WRITABLE_PATHS, ...ownHomePaths].map(underHome).filter((homePath) => !isSealed(homePath));
  const revealedOwnFolders = [input.worktree, ...input.ownFolders].filter((ownFolder) => input.hiddenFolders.some((hiddenFolder) => isPathInside(hiddenFolder, ownFolder)));
  return {
    network: {
      allowedDomains: [...new Set([...DEFAULT_ALLOWED_HOSTS, ...input.extraAllowedHosts])],
      deniedDomains: [],
      deniedResolvedAddresses: [...PRIVATE_NETWORK_RANGES],
      allowAllUnixSockets: true,
      ...(input.credentialProxy === null ? {} : { mitmProxy: { socketPath: input.credentialProxy.socketPath, domains: [...input.credentialProxy.hosts] } }),
    },
    filesystem: {
      denyRead: [...(input.credentialProxy === null ? [] : [input.credentialProxy.proxiesFolder]), input.glimmervoidHome, ...input.secretPaths, ...HOME_UNREADABLE_PATHS.map(underHome), ...otherAgentHomePaths.map(underHome), ...input.sealedLoginHomes, ...PLATFORM_SOCKET_PATHS, path.join('/run/user', String(input.userId)), ...input.hiddenFolders],
      allowRead: [...underGlimmervoidFolders(GLIMMERVOID_HOME_READABLE_FOLDERS), ...accountFolders, ...input.sealedLoginHomeCarveOuts, input.sessionTempFolder, ...input.readableFiles, ...revealedOwnFolders],
      allowWrite: [
        input.worktree,
        ...new Set(input.gitRepositories.map((repository) => repository.commonDir)),
        input.sessionTempFolder,
        ...underGlimmervoidFolders(GLIMMERVOID_HOME_WRITABLE_FOLDERS),
        ...accountFolders,
        ...input.sealedLoginHomeCarveOuts,
        ...writableHomePaths,
        ...revealedOwnFolders,
      ],
      denyWrite: [...new Set(input.gitRepositories.flatMap(gitMetadataDeniedWrites))],
    },
    enableWeakerNetworkIsolation: input.enableWeakerNetworkIsolation,
  };
}

function sandboxedCommand(input: SandboxedCommandInput): { file: string; args: string[] } {
  return {
    file: input.nodePath,
    args: [
      input.srtCliPath, '-s', input.settingsPath, '--',
      '/bin/sh', '-c', FORWARD_INGRESS_RESTORE_LINKS_THEN_EXEC, 'sh',
      input.socatPath, String(input.ingressPort), input.ingressSocketPath, input.agentTempFolder,
      String(input.restoredLinks.length), ...input.restoredLinks.flatMap((link) => [link.linkPath, link.target]),
      input.file, ...input.args,
    ],
  };
}

interface SeatbeltCommandInput {
  nodePath: string;
  seatbeltLauncherPath: string;
  settingsPath: string;
  ingressPort: number;
  agentTempFolder: string;
  restoredLinks: readonly SealedHomeLink[];
  file: string;
  args: readonly string[];
}

function seatbeltCommand(input: SeatbeltCommandInput): { file: string; args: string[] } {
  return {
    file: input.nodePath,
    args: [
      input.seatbeltLauncherPath, input.settingsPath, String(input.ingressPort), input.agentTempFolder,
      String(input.restoredLinks.length), ...input.restoredLinks.map((link) => link.linkPath),
      input.file, ...input.args,
    ],
  };
}

function srtSettingsPathIn(sessionTempFolder: string): string {
  return path.join(sessionTempFolder, SRT_SETTINGS_NAME);
}

function ingressSocketPathIn(socketFolder: string): string {
  return path.join(socketFolder, INGRESS_SOCKET_NAME);
}

function proxyTrustFilesIn(sessionTempFolder: string): { trustBundlePath: string; proxyCertificatePath: string } {
  return { trustBundlePath: path.join(sessionTempFolder, TRUST_BUNDLE_NAME), proxyCertificatePath: path.join(sessionTempFolder, PROXY_CERTIFICATE_NAME) };
}

function proxyTrustEnv(trustFiles: { trustBundlePath: string; proxyCertificatePath: string }): Record<string, string> {
  return { ...Object.fromEntries(TRUST_BUNDLE_ENV_NAMES.map((name) => [name, trustFiles.trustBundlePath])), NODE_EXTRA_CA_CERTS: trustFiles.proxyCertificatePath };
}

export type { CredentialProxyRoute, GitRepositoryLayout, SealedHomeLink };
export { CREDENTIAL_PROXIES_FOLDER_PREFIX, SHORT_SOCKET_FOLDER_PREFIX, buildSrtSettings, ingressSocketPathIn, proxyTrustEnv, proxyTrustFilesIn, sandboxedCommand, seatbeltCommand, srtSettingsPathIn };
