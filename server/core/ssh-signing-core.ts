interface SshPublicKey {
  keyType: string;
  keyBlob: string;
}

interface AgentSocketCandidate {
  socketPath: string;
  modifiedAtMs: number;
}

const LITERAL_KEY_PREFIX = 'key::';
const PUBLIC_KEY_LINE = /^(\S+) ([A-Za-z0-9+/]+={0,3})(?:\s.*)?$/;
const SIGNABLE_GIT_OBJECT_HEADER = /^(?:tree|object) [0-9a-f]{40}(?:[0-9a-f]{24})?\n/;
const FORWARDED_AGENT_DIR_NAME = /^(?:auth-agent|ssh-)[A-Za-z0-9_-]*$/;

function parseSshPublicKey(text: string): SshPublicKey | null {
  if (text.includes('PRIVATE KEY')) return null;
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  const keyLine = firstLine.startsWith(LITERAL_KEY_PREFIX) ? firstLine.slice(LITERAL_KEY_PREFIX.length) : firstLine;
  const match = PUBLIC_KEY_LINE.exec(keyLine);
  if (!match?.[1] || !match[2]) return null;
  return { keyType: match[1], keyBlob: match[2] };
}

function formatSshPublicKey(publicKey: SshPublicKey): string {
  return `${publicKey.keyType} ${publicKey.keyBlob}`;
}

function isSameSshKey(left: SshPublicKey, right: SshPublicKey): boolean {
  return left.keyType === right.keyType && left.keyBlob === right.keyBlob;
}

function agentListsKey(agentListing: string, wantedKey: SshPublicKey): boolean {
  return agentListing.split('\n').some((line) => {
    const listedKey = parseSshPublicKey(line);
    return listedKey !== null && isSameSshKey(listedKey, wantedKey);
  });
}

function isSignableGitObject(payload: Buffer): boolean {
  return SIGNABLE_GIT_OBJECT_HEADER.test(payload.subarray(0, 128).toString('latin1'));
}

function isForwardedAgentDirName(entryName: string): boolean {
  return FORWARDED_AGENT_DIR_NAME.test(entryName);
}

function orderAgentSockets({ inheritedSocket, discovered }: { inheritedSocket: string | null; discovered: readonly AgentSocketCandidate[] }): string[] {
  const newestFirst = [...discovered].sort((left, right) => right.modifiedAtMs - left.modifiedAtMs).map((candidate) => candidate.socketPath);
  const ordered = inheritedSocket ? [inheritedSocket, ...newestFirst] : newestFirst;
  return ordered.filter((socketPath, index) => ordered.indexOf(socketPath) === index);
}

const DARWIN_AGENT_APP_SOCKETS: readonly (readonly string[])[] = [
  ['Library', 'Containers', 'com.maxgoedjen.Secretive.SecretAgent', 'Data', 'socket.ssh'],
  ['Library', 'Group Containers', '2BUA8C4S2C.com.1password', 't', 'agent.sock'],
];

function wellKnownAgentSocketPaths({ homeDir, platform }: { homeDir: string; platform: NodeJS.Platform }): string[] {
  if (platform !== 'darwin') return [];
  return DARWIN_AGENT_APP_SOCKETS.map((segments) => [homeDir, ...segments].join('/'));
}

const COMMIT_SIGNING_SHIM_NAME = 'glimmervoid-ssh-sign';

function posixSingleQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

const GIT_CREDENTIAL_SHIM_NAME = 'glimmervoid-git-credential';

function cliShimText(cliLaunch: readonly string[], subcommand: string): string {
  return `#!/bin/sh\nexec ${cliLaunch.map(posixSingleQuote).join(' ')} ${subcommand} "$@"\n`;
}

function commitSigningShimText(cliLaunch: readonly string[]): string {
  return cliShimText(cliLaunch, 'ssh-sign');
}

function gitCredentialShimText(cliLaunch: readonly string[]): string {
  return cliShimText(cliLaunch, 'git-credential');
}

const GH_SHIM_NAME = 'gh';
const GH_SHIM_MARKER_LINE = 'GLIMMERVOID_GH_SHIM=1';
const GH_SHIM_HEAD_BYTES = 64;

function isGhShimHead(headText: string): boolean {
  return headText.split('\n')[1] === GH_SHIM_MARKER_LINE;
}

function ghShimText(cliLaunch: readonly string[], shimDir: string): string {
  return [
    '#!/bin/sh',
    GH_SHIM_MARKER_LINE,
    'real_gh=',
    'old_ifs=$IFS',
    'IFS=:',
    'for dir in $PATH; do',
    `  if [ "$dir" != ${posixSingleQuote(shimDir)} ] && [ -f "$dir/gh" ] && [ -x "$dir/gh" ] && ! head -c ${GH_SHIM_HEAD_BYTES} "$dir/gh" 2>/dev/null | grep -q '^${GH_SHIM_MARKER_LINE}$'; then real_gh="$dir/gh"; break; fi`,
    'done',
    'IFS=$old_ifs',
    `if [ -z "$real_gh" ]; then echo 'gh: command not found' >&2; exit 127; fi`,
    'if [ -z "$GH_TOKEN$GITHUB_TOKEN" ] && ! "$real_gh" auth token >/dev/null 2>&1 && ! "$real_gh" auth status --hostname github.com >/dev/null 2>&1; then',
    `  GH_TOKEN=$(printf 'protocol=https\\nhost=github.com\\n\\n' | ${cliLaunch.map(posixSingleQuote).join(' ')} git-credential get 2>/dev/null | sed -n 's/^password=//p')`,
    '  if [ -n "$GH_TOKEN" ]; then export GH_TOKEN; else unset GH_TOKEN; fi',
    'fi',
    'exec "$real_gh" "$@"',
    '',
  ].join('\n');
}

const NO_AGENT_HOLDS_KEY = 'no reachable ssh agent holds the signing key; connect to this machine with agent forwarding (ssh -A, or ForwardAgent yes from coder config-ssh) and commit again';

export { agentListsKey, COMMIT_SIGNING_SHIM_NAME, commitSigningShimText, formatSshPublicKey, GH_SHIM_HEAD_BYTES, GH_SHIM_NAME, ghShimText, isGhShimHead, GIT_CREDENTIAL_SHIM_NAME, gitCredentialShimText, isForwardedAgentDirName, isSameSshKey, isSignableGitObject, NO_AGENT_HOLDS_KEY, orderAgentSockets, parseSshPublicKey, wellKnownAgentSocketPaths };
export type { AgentSocketCandidate, SshPublicKey };
