import { createHash } from 'node:crypto';
import type { SshPublicKey } from './ssh-signing-core.ts';
import type { CommitSigningRecord, CommitSigningStatus } from '../../shared/contracts/commit-signing.ts';

const OWN_SIGNING_SETTINGS_PATTERN = '^(user\\.signingkey|gpg\\..+|(commit|tag|push)\\.gpgsign)$';
const HOST_SIGNING_MARKER_LINE = '[glimmervoid]\n\thostSigning = true\n';
const INCLUDED_SYSTEM_CONFIG_PATTERN = /^\[include\]\n\tpath = (.+)$/m;

function sshPublicKeyFingerprint(publicKey: SshPublicKey): string {
  const digest = createHash('sha256').update(Buffer.from(publicKey.keyBlob, 'base64')).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

function quoteGitConfigValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function hostSigningSystemConfigText({ publicKeyText, baseSystemConfigPath }: { publicKeyText: string; baseSystemConfigPath: string | null }): string {
  const defaults = `${HOST_SIGNING_MARKER_LINE}[gpg]\n\tformat = ssh\n[user]\n\tsigningkey = ${quoteGitConfigValue(`key::${publicKeyText}`)}\n[commit]\n\tgpgsign = true\n`;
  return baseSystemConfigPath === null ? defaults : `${defaults}[include]\n\tpath = ${quoteGitConfigValue(baseSystemConfigPath)}\n`;
}

function isHostSigningSystemConfig(configText: string): boolean {
  return configText.startsWith(HOST_SIGNING_MARKER_LINE);
}

function includedSystemConfigPath(configText: string): string | null {
  const quotedPath = INCLUDED_SYSTEM_CONFIG_PATTERN.exec(configText)?.[1];
  if (!quotedPath) return null;
  return quotedPath.slice(1, -1).replace(/\\(["\\])/g, '$1');
}

function hostSigningGitEnv({ systemConfigPath, baseSystemConfigPath, signsWithHostKey, inheritsHostSigningConfig }: {
  systemConfigPath: string;
  baseSystemConfigPath: string | null;
  signsWithHostKey: boolean;
  inheritsHostSigningConfig: boolean;
}): Record<string, string> {
  if (signsWithHostKey) return { GIT_CONFIG_SYSTEM: systemConfigPath, GIT_CONFIG_NOSYSTEM: '0' };
  if (!inheritsHostSigningConfig) return {};
  return baseSystemConfigPath === null ? { GIT_CONFIG_NOSYSTEM: '1' } : { GIT_CONFIG_SYSTEM: baseSystemConfigPath, GIT_CONFIG_NOSYSTEM: '0' };
}

function commitSigningStatusOf({ hostKey, record, connectedLogin, problem }: {
  hostKey: { publicKeyText: string; fingerprint: string } | null;
  record: CommitSigningRecord;
  connectedLogin: string | null;
  problem: string | null;
}): CommitSigningStatus {
  const canRegister = connectedLogin !== null;
  if (!hostKey) return { state: 'off', fingerprint: null, publicKey: null, login: null, canRegister, problem };
  const registration = record.github;
  return {
    state: registration ? 'registered' : 'unregistered',
    fingerprint: hostKey.fingerprint,
    publicKey: hostKey.publicKeyText,
    login: registration?.login ?? connectedLogin,
    canRegister,
    problem,
  };
}

function githubRefusalText(action: 'register' | 'delete' | 'list', status: number, githubMessage: string | null): string {
  const said = githubMessage ? `: ${githubMessage}` : '';
  if (status === 401) return `GitHub did not accept the connected sign-in (HTTP 401${said}). Reconnect GitHub.`;
  if (status === 403 || status === 404) return `GitHub refused to ${action} the signing key (HTTP ${status}${said}). The Glimmervoid App needs the account permission "SSH signing keys: Read and write"; reconnect GitHub after it is granted.`;
  return `GitHub refused to ${action} the signing key (HTTP ${status}${said}).`;
}

export { commitSigningStatusOf, githubRefusalText, hostSigningGitEnv, hostSigningSystemConfigText, includedSystemConfigPath, isHostSigningSystemConfig, OWN_SIGNING_SETTINGS_PATTERN, sshPublicKeyFingerprint };
