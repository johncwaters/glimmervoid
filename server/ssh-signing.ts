import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execFileAsync } from './child-process-safe.ts';
import { writeTextAtomicSync } from './json-file.ts';
import { agentListsKey, COMMIT_SIGNING_SHIM_NAME, commitSigningShimText, formatSshPublicKey, isForwardedAgentDirName, NO_AGENT_HOLDS_KEY, orderAgentSockets, parseSshPublicKey } from './core/ssh-signing-core.ts';
import type { AgentSocketCandidate, SshPublicKey } from './core/ssh-signing-core.ts';
import { errorMessage } from '../shared/text.ts';

const AGENT_LISTING_TIMEOUT_MS = 5000;
const SIGNING_TIMEOUT_MS = 60_000;

type SignOutcome = { ok: true; signature: string } | { ok: false; error: string };

interface SshSignerOptions {
  env?: NodeJS.ProcessEnv;
  agentSearchRoots?: readonly string[];
  ownerUid?: number | null;
}

interface SshSigner {
  signWithAgent: (request: { publicKey: SshPublicKey; namespace: string; payload: Buffer }) => Promise<SignOutcome>;
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

function createSshSigner({ env = process.env, agentSearchRoots = defaultAgentSearchRoots(), ownerUid = process.getuid?.() ?? null }: SshSignerOptions = {}): SshSigner {
  async function agentHolds(socketPath: string, publicKey: SshPublicKey): Promise<boolean> {
    const listing = await execFileAsync('ssh-add', ['-L'], { env: { ...env, SSH_AUTH_SOCK: socketPath }, timeout: AGENT_LISTING_TIMEOUT_MS, encoding: 'utf8' })
      .then(({ stdout }) => stdout, () => '');
    return agentListsKey(listing, publicKey);
  }

  async function agentEnvFor(publicKey: SshPublicKey): Promise<{ SSH_AUTH_SOCK: string } | null> {
    const discovered = (await Promise.all(agentSearchRoots.map((searchRoot) => forwardedSocketsIn(searchRoot, ownerUid)))).flat();
    const candidates = orderAgentSockets({ inheritedSocket: env.SSH_AUTH_SOCK || null, discovered });
    for (const socketPath of candidates) {
      if (await agentHolds(socketPath, publicKey)) return { SSH_AUTH_SOCK: socketPath };
    }
    return null;
  }

  async function signWithAgent({ publicKey, namespace, payload }: { publicKey: SshPublicKey; namespace: string; payload: Buffer }): Promise<SignOutcome> {
    const agentEnv = await agentEnvFor(publicKey);
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

  return { signWithAgent, agentEnvFor };
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

function installCommitSigningShim({ binDir, nodePath, cliPath, platform = process.platform, log = console }: {
  binDir: string;
  nodePath: string;
  cliPath: string;
  platform?: NodeJS.Platform;
  log?: Pick<Console, 'warn'>;
}): string | null {
  if (platform === 'win32') return null;
  const shimPath = path.join(binDir, COMMIT_SIGNING_SHIM_NAME);
  const shimText = commitSigningShimText({ nodePath, cliPath });
  try {
    if (readTextOrNull(shimPath) !== shimText) writeTextAtomicSync(shimPath, shimText, { mode: 0o755, mkdir: true, enforceMode: true });
    return shimPath;
  } catch (error) {
    log.warn(`[sign] commit signing is off: could not write ${shimPath}: ${errorMessage(error)}`);
    return null;
  }
}

export { createSshSigner, installCommitSigningShim, readSigningKeySetting };
export type { SshSigner };
