import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execFileAsync } from './child-process-safe.ts';
import { writeTextAtomicSync } from './json-file.ts';
import { agentListsKey, COMMIT_SIGNING_SHIM_NAME, commitSigningShimText, formatSshPublicKey, GIT_CREDENTIAL_SHIM_NAME, gitCredentialShimText, isForwardedAgentDirName, NO_AGENT_HOLDS_KEY, orderAgentSockets, parseSshPublicKey, wellKnownAgentSocketPaths } from './core/ssh-signing-core.ts';
import type { AgentSocketCandidate, SshPublicKey } from './core/ssh-signing-core.ts';
import type { HostSigningKeyStore } from './commit-signing.ts';
import { errorMessage } from '../shared/text.ts';
import { clock } from '../shared/clock.ts';

const AGENT_LISTING_TIMEOUT_MS = 5000;
const SIGNING_TIMEOUT_MS = 60_000;
const FORWARDED_AGENT_RECONNECT_WAIT_MS = 30_000;
const AGENT_RESCAN_INTERVAL_MS = 1000;

type SignOutcome = { ok: true; signature: string } | { ok: false; error: string };

interface SshSignerOptions {
  env?: NodeJS.ProcessEnv;
  agentSearchRoots?: readonly string[];
  wellKnownAgentSockets?: readonly string[];
  ownerUid?: number | null;
  agentWaitMs?: number;
  agentRescanIntervalMs?: number;
  hostSigningKeys?: Pick<HostSigningKeyStore, 'signIfHeld'> | null;
}

interface SshSigner {
  sign: (request: { publicKey: SshPublicKey; namespace: string; payload: Buffer }) => Promise<SignOutcome>;
  agentEnvFor: (publicKey: SshPublicKey) => Promise<{ SSH_AUTH_SOCK: string } | null>;
}

function defaultAgentSearchRoots(): string[] {
  const roots = ['/tmp', os.tmpdir()];
  return roots.filter((root, index) => roots.indexOf(root) === index);
}

async function readEntryNames(directory: string): Promise<string[]> {
  return fs.readdir(directory).catch(() => []);
}

async function ownedSocketAt(socketPath: string, ownerUid: number | null): Promise<AgentSocketCandidate | null> {
  const stats = await fs.lstat(socketPath).catch(() => null);
  if (!stats?.isSocket()) return null;
  if (ownerUid !== null && stats.uid !== ownerUid) return null;
  return { socketPath, modifiedAtMs: stats.mtimeMs };
}

async function forwardedSocketsIn(searchRoot: string, ownerUid: number | null): Promise<AgentSocketCandidate[]> {
  const agentDirs = (await readEntryNames(searchRoot)).filter(isForwardedAgentDirName).map((entryName) => path.join(searchRoot, entryName));
  const socketPaths = (await Promise.all(agentDirs.map(async (agentDir) => (await readEntryNames(agentDir)).map((entryName) => path.join(agentDir, entryName))))).flat();
  const candidates = await Promise.all(socketPaths.map((socketPath) => ownedSocketAt(socketPath, ownerUid)));
  return candidates.filter((candidate) => candidate !== null);
}

function createSshSigner({ env = process.env, agentSearchRoots = defaultAgentSearchRoots(), wellKnownAgentSockets = wellKnownAgentSocketPaths({ homeDir: os.homedir(), platform: process.platform }), ownerUid = process.getuid?.() ?? null, agentWaitMs = FORWARDED_AGENT_RECONNECT_WAIT_MS, agentRescanIntervalMs = AGENT_RESCAN_INTERVAL_MS, hostSigningKeys = null }: SshSignerOptions = {}): SshSigner {
  async function agentHolds(socketPath: string, publicKey: SshPublicKey): Promise<boolean> {
    const listing = await execFileAsync('ssh-add', ['-L'], { env: { ...env, SSH_AUTH_SOCK: socketPath }, timeout: AGENT_LISTING_TIMEOUT_MS, encoding: 'utf8' })
      .then(({ stdout }) => stdout, () => '');
    return agentListsKey(listing, publicKey);
  }

  async function agentEnvFor(publicKey: SshPublicKey): Promise<{ SSH_AUTH_SOCK: string } | null> {
    const forwarded = (await Promise.all(agentSearchRoots.map((searchRoot) => forwardedSocketsIn(searchRoot, ownerUid)))).flat();
    const wellKnown = (await Promise.all(wellKnownAgentSockets.map((socketPath) => ownedSocketAt(socketPath, ownerUid)))).filter((candidate) => candidate !== null);
    const discovered = [...forwarded, ...wellKnown];
    const candidates = orderAgentSockets({ inheritedSocket: env.SSH_AUTH_SOCK || null, discovered });
    for (const socketPath of candidates) {
      if (await agentHolds(socketPath, publicKey)) return { SSH_AUTH_SOCK: socketPath };
    }
    return null;
  }

  async function agentEnvBefore(publicKey: SshPublicKey, deadlineMs: number): Promise<{ SSH_AUTH_SOCK: string } | null> {
    const agentEnv = await agentEnvFor(publicKey);
    if (agentEnv || clock.nowMs() >= deadlineMs) return agentEnv;
    await new Promise((resolve) => { setTimeout(resolve, agentRescanIntervalMs); });
    return agentEnvBefore(publicKey, deadlineMs);
  }

  async function sign({ publicKey, namespace, payload }: { publicKey: SshPublicKey; namespace: string; payload: Buffer }): Promise<SignOutcome> {
    const hostSigned = await hostSigningKeys?.signIfHeld({ publicKey, namespace, payload }) ?? null;
    if (hostSigned) return hostSigned;
    const agentEnv = await agentEnvBefore(publicKey, clock.nowMs() + agentWaitMs);
    if (!agentEnv) return { ok: false, error: NO_AGENT_HOLDS_KEY };
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-sign-'));
    try {
      const keyPath = path.join(workDir, 'signing-key.pub');
      const payloadPath = path.join(workDir, 'payload');
      await fs.writeFile(keyPath, `${formatSshPublicKey(publicKey)}\n`, { mode: 0o600 });
      await fs.writeFile(payloadPath, payload, { mode: 0o600 });
      await execFileAsync('ssh-keygen', ['-Y', 'sign', '-n', namespace, '-f', keyPath, '-U', payloadPath], {
        env: { ...env, ...agentEnv }, timeout: SIGNING_TIMEOUT_MS, encoding: 'utf8',
      });
      return { ok: true, signature: await fs.readFile(`${payloadPath}.sig`, 'utf8') };
    } catch (error) {
      const stderr = (error as { stderr?: unknown } | null)?.stderr;
      return { ok: false, error: `ssh-keygen could not sign: ${typeof stderr === 'string' && stderr.trim() ? stderr.trim() : errorMessage(error)}` };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  return { sign, agentEnvFor };
}

async function readSigningKeySetting(setting: string, cwd: string): Promise<SshPublicKey | null> {
  const literalKey = parseSshPublicKey(setting);
  if (literalKey) return literalKey;
  const keyPath = path.resolve(cwd, setting.replace(/^~(?=\/|$)/, os.homedir()));
  return parseSshPublicKey(await fs.readFile(keyPath, 'utf8').catch(() => ''));
}

function readTextOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

type ShimInstall = { binDir: string; cliLaunch: readonly string[]; platform?: NodeJS.Platform; log?: Pick<Console, 'warn'> };

function installCliShim({ binDir, platform = process.platform, log = console }: ShimInstall, { shimName, shimText, offWarning }: { shimName: string; shimText: string; offWarning: string }): string | null {
  if (platform === 'win32') return null;
  const shimPath = path.join(binDir, shimName);
  try {
    if (readTextOrNull(shimPath) !== shimText) writeTextAtomicSync(shimPath, shimText, { mode: 0o755, mkdir: true, enforceMode: true });
    return shimPath;
  } catch (error) {
    log.warn(`${offWarning}: could not write ${shimPath}: ${errorMessage(error)}`);
    return null;
  }
}

function installCommitSigningShim(install: ShimInstall): string | null {
  return installCliShim(install, { shimName: COMMIT_SIGNING_SHIM_NAME, shimText: commitSigningShimText(install.cliLaunch), offWarning: '[sign] commit signing is off' });
}

function installGitCredentialShim(install: ShimInstall): string | null {
  return installCliShim(install, { shimName: GIT_CREDENTIAL_SHIM_NAME, shimText: gitCredentialShimText(install.cliLaunch), offWarning: '[git-credential] the GitHub credential helper is off' });
}

export { createSshSigner, installCommitSigningShim, installGitCredentialShim, readSigningKeySetting };
export type { SshSigner };
