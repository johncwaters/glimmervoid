import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execFileAsync } from './child-process-safe.ts';
import { runGit } from './git/git-exec.ts';
import { formatSshPublicKey, isSameSshKey, parseSshPublicKey } from './core/ssh-signing-core.ts';
import type { SshPublicKey } from './core/ssh-signing-core.ts';
import { hostSigningGitEnv, hostSigningSystemConfigText, includedSystemConfigPath, isHostSigningSystemConfig, OWN_SIGNING_SETTINGS_PATTERN, sshPublicKeyFingerprint } from './core/commit-signing-core.ts';
import { errorMessage } from '../shared/text.ts';

const KEY_FOLDER_MODE = 0o700;
const PRIVATE_KEY_FILE_NAME = 'signing-key';
const KEY_COMMENT = 'glimmervoid-commit-signing';
const SYSTEM_CONFIG_FILE_NAME = 'system.gitconfig';
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

function gitExitCodeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function createHostSigningKeyStore({ folder }: { folder: string }): HostSigningKeyStore {
  const privateKeyPath = path.join(folder, PRIVATE_KEY_FILE_NAME);
  const publicKeyPath = `${privateKeyPath}.pub`;
  const systemConfigPath = path.join(folder, SYSTEM_CONFIG_FILE_NAME);
  let systemConfigBase: Promise<SystemConfigBase> | null = null;

  async function read(): Promise<HostSigningKey | null> {
    const privateKeyStats = await fs.stat(privateKeyPath).catch(() => null);
    if (!privateKeyStats?.isFile()) return null;
    return hostSigningKeyOf(await fs.readFile(publicKeyPath, 'utf8').catch(() => ''));
  }

  async function setup(): Promise<HostSigningKey> {
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
    await fs.rm(systemConfigPath, { force: true });
    await fs.rm(privateKeyPath, { force: true });
    await fs.rm(publicKeyPath, { force: true });
  }

  async function writeSystemConfig(configText: string): Promise<void> {
    const current = await fs.readFile(systemConfigPath, 'utf8').catch(() => null);
    if (current === configText) return;
    const stagedPath = `${systemConfigPath}.${process.pid}.tmp`;
    await fs.writeFile(stagedPath, configText, { mode: 0o600 });
    await fs.rename(stagedPath, systemConfigPath);
  }

  async function projectSetsOwnSigning(cwd: string, base: SystemConfigBase): Promise<boolean> {
    const baseSystemEnv = hostSigningGitEnv({ systemConfigPath, baseSystemConfigPath: base.baseSystemConfigPath, signsWithHostKey: false, inheritsHostSigningConfig: true });
    const ownSigning = await runGit(['config', '--get-regexp', OWN_SIGNING_SETTINGS_PATTERN], { cwd, env: baseSystemEnv });
    return ownSigning.ok || gitExitCodeOf(ownSigning.error) !== GIT_CONFIG_NO_MATCH_EXIT_CODE;
  }

  async function gitEnvFor(cwd: string): Promise<Record<string, string>> {
    systemConfigBase ??= discoverSystemConfigBase();
    const base = await systemConfigBase;
    const held = await read();
    const signsWithHostKey = held !== null && !await projectSetsOwnSigning(cwd, base);
    if (held && signsWithHostKey) await writeSystemConfig(hostSigningSystemConfigText({ publicKeyText: held.publicKeyText, baseSystemConfigPath: base.baseSystemConfigPath }));
    return hostSigningGitEnv({ systemConfigPath, baseSystemConfigPath: base.baseSystemConfigPath, signsWithHostKey, inheritsHostSigningConfig: base.inheritsHostSigningConfig });
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

  return { read, setup, remove, gitEnvFor, signIfHeld };
}

export { createHostSigningKeyStore };
export type { HostSigningKeyStore };
