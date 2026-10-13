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

const COMMIT_SIGNING_SHIM_NAME = 'glimmervoid-ssh-sign';

function posixSingleQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function commitSigningShimText({ nodePath, cliPath }: { nodePath: string; cliPath: string }): string {
  return `#!/bin/sh\nexec ${posixSingleQuote(nodePath)} ${posixSingleQuote(cliPath)} ssh-sign "$@"\n`;
}

const NO_AGENT_HOLDS_KEY = 'no reachable ssh agent holds the signing key; connect to this machine with agent forwarding (ssh -A, or ForwardAgent yes from coder config-ssh) and commit again';

export { agentListsKey, COMMIT_SIGNING_SHIM_NAME, commitSigningShimText, formatSshPublicKey, isForwardedAgentDirName, isSignableGitObject, NO_AGENT_HOLDS_KEY, orderAgentSockets, parseSshPublicKey };
export type { AgentSocketCandidate, SshPublicKey };
