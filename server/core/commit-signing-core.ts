import { createHash } from 'node:crypto';
import type { SshPublicKey } from './ssh-signing-core.ts';

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

export { hostSigningGitEnv, hostSigningSystemConfigText, includedSystemConfigPath, isHostSigningSystemConfig, OWN_SIGNING_SETTINGS_PATTERN, sshPublicKeyFingerprint };
