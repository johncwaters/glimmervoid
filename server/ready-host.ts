import os from 'node:os';

import type { CommitSigningStatus, GitIdentity } from '../shared/contracts/commit-signing.ts';
import type { HostReady } from '../shared/contracts/host-ready.ts';
import type { GithubConnection } from '../shared/contracts/watcher-link.ts';
import { hostReadyOf } from './core/ready-host-core.ts';
import type { GhState } from './core/ready-host-core.ts';
import { runGh, runGit } from './git/git-exec.ts';

const PROBE_TIMEOUT_MS = 5000;

async function globalGitSetting(name: string): Promise<string | null> {
  const read = await runGit(['config', '--global', '--get', name], { cwd: os.homedir(), timeoutMs: PROBE_TIMEOUT_MS });
  return read.ok ? read.out.trim() || null : null;
}

async function ownGitIdentity(): Promise<GitIdentity | null> {
  const [name, email] = await Promise.all([globalGitSetting('user.name'), globalGitSetting('user.email')]);
  return name !== null && email !== null ? { name, email } : null;
}

async function isGhSignedIn(): Promise<boolean> {
  const ownToken = await runGh(['auth', 'token'], { timeoutMs: PROBE_TIMEOUT_MS });
  if (ownToken.ok && ownToken.out.trim() !== '') return true;
  return (await runGh(['auth', 'status', '--hostname', 'github.com'], { timeoutMs: PROBE_TIMEOUT_MS })).ok;
}

async function ghStateOf(ghShimDir: string | null, connectedLogin: string | null): Promise<GhState> {
  if (!(await runGh(['--version'], { timeoutMs: PROBE_TIMEOUT_MS })).ok) return 'missing';
  if (await isGhSignedIn()) return 'signed-in';
  return ghShimDir !== null && connectedLogin !== null ? 'wrapped' : 'signed-out';
}

function createHostReady({ githubConnection, commitSigningStatus, ghShimDir }: {
  githubConnection: () => Promise<GithubConnection | null>;
  commitSigningStatus: () => Promise<CommitSigningStatus>;
  ghShimDir: string | null;
}): { read: () => Promise<HostReady> } {
  async function read(): Promise<HostReady> {
    const connection = await githubConnection().catch(() => null);
    const connectedLogin = connection?.state === 'connected' ? connection.login : null;
    const [signing, ownIdentity, gh] = await Promise.all([commitSigningStatus().catch(() => null), ownGitIdentity(), ghStateOf(ghShimDir, connectedLogin)]);
    return hostReadyOf({ connectedLogin, signing, ownIdentity, gh });
  }

  return { read };
}

export { createHostReady };
export type HostReadyReader = ReturnType<typeof createHostReady>;
