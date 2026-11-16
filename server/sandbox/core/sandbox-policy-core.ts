import path from 'node:path';

const INGRESS_SOCKET_NAME = 'ingress.sock';
const SRT_SETTINGS_NAME = 'srt.json';
const SHORT_SOCKET_FOLDER_PREFIX = '/tmp/glimmervoid-sandbox-';

const DEFAULT_ALLOWED_HOSTS: readonly string[] = Object.freeze([
  'anthropic.com', '*.anthropic.com', 'claude.com', '*.claude.com', 'claude.ai', '*.claude.ai',
  'openai.com', '*.openai.com', 'chatgpt.com', '*.chatgpt.com',
  'kimi.com', '*.kimi.com', 'kimi.ai', '*.kimi.ai', 'moonshot.cn', '*.moonshot.cn',
  'github.com', '*.github.com', 'githubusercontent.com', '*.githubusercontent.com',
  'registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org',
  'crates.io', 'static.crates.io', 'index.crates.io', 'proxy.golang.org', 'sum.golang.org',
]);

const GLIMMERVOID_HOME_READABLE_FOLDERS: readonly string[] = Object.freeze([
  'bin', 'runtime', 'sane-yolo', path.join('scratch', 'glimmervoid-hooks'), 'packs', 'pack-session-files', 'uploads', 'agent-homes', 'agent-accounts',
]);

const GLIMMERVOID_HOME_WRITABLE_FOLDERS: readonly string[] = Object.freeze(['agent-homes', 'agent-accounts']);

const HOME_UNREADABLE_PATHS: readonly string[] = Object.freeze(['.ssh', path.join('.config', 'gh'), '.git-credentials', '.netrc', '.docker']);

const HOME_WRITABLE_PATHS: readonly string[] = Object.freeze([
  '.claude', '.claude.json', '.codex', '.kimi', '.kimi-code', '.cache', '.npm', path.join('.local', 'state'),
]);

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
  userId: number;
  worktree: string;
  gitRepositories: readonly GitRepositoryLayout[];
  sessionTempFolder: string;
  readableFiles: readonly string[];
  extraAllowedHosts: readonly string[];
}

interface SrtSettings {
  network: { allowedDomains: string[]; deniedDomains: string[]; allowAllUnixSockets: boolean };
  filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[]; denyWrite: string[] };
}

interface SandboxedCommandInput {
  nodePath: string;
  srtCliPath: string;
  socatPath: string;
  settingsPath: string;
  ingressPort: number;
  ingressSocketPath: string;
  agentTempFolder: string;
  file: string;
  args: readonly string[];
}

const FORWARD_INGRESS_THEN_EXEC = '"$1" "TCP-LISTEN:$2,bind=127.0.0.1,fork,reuseaddr" "UNIX-CONNECT:$3" & export TMPDIR="$4"; shift 4; exec "$@"';

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
  return {
    network: {
      allowedDomains: [...new Set([...DEFAULT_ALLOWED_HOSTS, ...input.extraAllowedHosts])],
      deniedDomains: [],
      allowAllUnixSockets: true,
    },
    filesystem: {
      denyRead: [input.glimmervoidHome, ...input.secretPaths, ...HOME_UNREADABLE_PATHS.map(underHome), ...PLATFORM_SOCKET_PATHS, path.join('/run/user', String(input.userId))],
      allowRead: [...underGlimmervoidFolders(GLIMMERVOID_HOME_READABLE_FOLDERS), input.sessionTempFolder, ...input.readableFiles],
      allowWrite: [
        input.worktree,
        ...new Set(input.gitRepositories.map((repository) => repository.commonDir)),
        input.sessionTempFolder,
        ...underGlimmervoidFolders(GLIMMERVOID_HOME_WRITABLE_FOLDERS),
        ...HOME_WRITABLE_PATHS.map(underHome),
      ],
      denyWrite: [...new Set(input.gitRepositories.flatMap(gitMetadataDeniedWrites))],
    },
  };
}

function sandboxedCommand(input: SandboxedCommandInput): { file: string; args: string[] } {
  return {
    file: input.nodePath,
    args: [
      input.srtCliPath, '-s', input.settingsPath, '--',
      '/bin/sh', '-c', FORWARD_INGRESS_THEN_EXEC, 'sh',
      input.socatPath, String(input.ingressPort), input.ingressSocketPath, input.agentTempFolder, input.file, ...input.args,
    ],
  };
}

function srtSettingsPathIn(sessionTempFolder: string): string {
  return path.join(sessionTempFolder, SRT_SETTINGS_NAME);
}

function ingressSocketPathIn(socketFolder: string): string {
  return path.join(socketFolder, INGRESS_SOCKET_NAME);
}

export type { GitRepositoryLayout };
export { SHORT_SOCKET_FOLDER_PREFIX, buildSrtSettings, ingressSocketPathIn, sandboxedCommand, srtSettingsPathIn };
