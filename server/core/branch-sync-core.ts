export const GIT_FETCH_TIMEOUT_MS = 8000;

type BranchSyncState = 'no-upstream' | 'unknown' | 'diverged' | 'ahead' | 'behind' | 'in-sync';
type ResyncAction = 'ff-merge' | 'ff-fetch' | 'push' | 'none';

interface LeftRightCount {
  behind: number;
  ahead: number;
}

function parseLeftRightCount(output: string | null | undefined): LeftRightCount | null {
  const parts = String(output || '').trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const behind = Number(parts[0]);
  const ahead = Number(parts[1]);
  if (!Number.isInteger(behind) || !Number.isInteger(ahead) || behind < 0 || ahead < 0) return null;
  return { behind, ahead };
}

function decideBranchSyncState({
  hasUpstream,
  ahead,
  behind,
}: {
  hasUpstream: boolean;
  ahead?: number;
  behind?: number;
}): BranchSyncState {
  if (!hasUpstream) return 'no-upstream';
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) return 'unknown';
  if (ahead === undefined || behind === undefined) return 'unknown';
  if (ahead > 0 && behind > 0) return 'diverged';
  if (ahead > 0) return 'ahead';
  if (behind > 0) return 'behind';
  return 'in-sync';
}

function parseRemoteFromUpstream(upstream: string | null | undefined): string {
  const idx = String(upstream || '').indexOf('/');
  if (idx === -1) return 'origin';
  return String(upstream).slice(0, idx);
}

const BRANCH_UPSTREAM_FORMAT = '%(refname)%09%(upstream:short)%09%(upstream:track,nobracket)%09%(upstream:remotename)%09%(upstream:remoteref)';

const LOCAL_REMOTE = '.';

interface BranchUpstream {
  upstream: string;
  remote: string;
  remoteBranch: string;
}

function parseBranchUpstream(forEachRefOutput: string, branch: string): BranchUpstream | null {
  const fieldsOfBranch = forEachRefOutput.split('\n').map((line) => line.split('\t')).find(([refName]) => refName === `refs/heads/${branch}`);
  if (!fieldsOfBranch) return null;
  const [, upstream, tracking, remoteName, remoteRef] = fieldsOfBranch;
  if (!upstream || tracking === 'gone') return null;
  return {
    upstream,
    remote: remoteName?.trim() || parseRemoteFromUpstream(upstream),
    remoteBranch: remoteRef?.trim().replace(/^refs\/heads\//, '') || branch,
  };
}

function isLocalRemote(remote: string): boolean {
  return remote === LOCAL_REMOTE;
}

function decideResyncAction(state: string, isCheckedOut: boolean): ResyncAction {
  if (state === 'behind') return isCheckedOut ? 'ff-merge' : 'ff-fetch';
  if (state === 'ahead') return 'push';
  return 'none';
}

interface ResyncCommand {
  args: string[];
  timeoutMs: number | undefined;
  successAction: 'fast-forwarded' | 'pushed';
}

function buildResyncCommand(
  decision: string,
  { upstream, branch, remote, remoteBranch = branch }: { upstream: string; branch: string; remote: string; remoteBranch?: string },
): ResyncCommand | null {
  if (decision === 'ff-merge') return { args: ['merge', '--ff-only', upstream], timeoutMs: undefined, successAction: 'fast-forwarded' };
  if (isLocalRemote(remote)) return null;
  if (decision === 'ff-fetch') return { args: ['fetch', '--quiet', remote, `${remoteBranch}:${branch}`], timeoutMs: GIT_FETCH_TIMEOUT_MS, successAction: 'fast-forwarded' };
  if (decision === 'push') return { args: ['push', remote, remoteBranch === branch ? branch : `${branch}:${remoteBranch}`], timeoutMs: 15000, successAction: 'pushed' };
  return null;
}

function firstGitErrorLine(err: unknown): string {

  const maxGitErrorLineLength = 200;
  const raw = errorMessageOrText(err);
  const msg = raw
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/^Command failed:[^\n]*\n?/, '');
  const lines = msg.split('\n').map((line) => line.trim()).filter(Boolean);
  const preferredLine = lines.find((line) => line.startsWith('fatal:') || line.startsWith('error:') || line.startsWith('! ['));
  const line = preferredLine || lines[0];
  return line ? line.slice(0, maxGitErrorLineLength) : 'git command failed';
}

function errorMessageOrText(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
    return err.message;
  }
  if (!err) return '';
  return String(err);
}

export type { BranchUpstream };

export {
  BRANCH_UPSTREAM_FORMAT,
  parseLeftRightCount,
  decideBranchSyncState,
  parseRemoteFromUpstream,
  parseBranchUpstream,
  isLocalRemote,
  decideResyncAction,
  buildResyncCommand,
  firstGitErrorLine,
};
