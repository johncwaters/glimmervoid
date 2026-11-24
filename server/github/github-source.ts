import os from 'node:os';
import path from 'node:path';

import { clock } from '../../shared/clock.ts';
import { runGh } from '../git/git-exec.ts';
import { watchPath } from '../path-watch.ts';

type GithubSource = { kind: 'gh' } | { kind: 'connection'; token: string } | { kind: 'none' };
type GithubSourceKind = GithubSource['kind'];
type GithubSourceReader = { current(): Promise<GithubSource> };
type GhLoginAnswer = 'present' | 'absent' | 'unknown';

interface GithubSourceDependencies {
  userCredential: () => Promise<{ token: string } | null>;
  readGhLogin?: () => Promise<GhLoginAnswer>;
  followGhLogin?: (onChange: () => void) => void;
  now?: () => number;
}

const GH_LOGIN_ANSWER_TTL_MS = 60_000;

const GH_LOGIN_READ_TIMEOUT_MS = 20_000;
const GH_WITHOUT_LOGIN_RE = /no oauth token|not logged in|ENOENT/i;
const GH_TOKEN_REFUSED_RE = /HTTP 401/;
const GH_API_WITHOUT_LOGIN_RE = /gh auth login|GH_TOKEN environment variable/;
const NO_GITHUB_SOURCE_TEXT = 'GitHub is not reachable: gh has no login on this machine and GitHub is not connected in Settings';
const GH_LOGIN_SOURCE: GithubSourceReader = { current: async () => ({ kind: 'gh' }) };

function ghLoginAnswerOf(tokenRead: { ok: boolean; out: string; err: string }): GhLoginAnswer {
  if (tokenRead.ok && tokenRead.out.trim() !== '') return 'present';
  if (!tokenRead.ok && GH_WITHOUT_LOGIN_RE.test(tokenRead.err)) return 'absent';
  return 'unknown';
}

function ghLoginAnswerOfViewerRead(viewerRead: { ok: boolean; err: string }, tokenAnswer: 'present' | 'unknown'): GhLoginAnswer {
  if (viewerRead.ok) return 'present';
  if ([GH_TOKEN_REFUSED_RE, GH_WITHOUT_LOGIN_RE, GH_API_WITHOUT_LOGIN_RE].some((noLoginText) => noLoginText.test(viewerRead.err))) return 'absent';
  return tokenAnswer;
}

function ghConfigFolder(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'gh');
  if (process.platform === 'win32' && env.AppData) return path.join(env.AppData, 'GitHub CLI');
  return path.join(os.homedir(), '.config', 'gh');
}

function followGhHostsFile(onChange: () => void): void {
  watchPath(path.join(ghConfigFolder(), 'hosts.yml'), onChange);
}

async function readGhLoginFromGh(): Promise<GhLoginAnswer> {
  const tokenAnswer = ghLoginAnswerOf(await runGh(['auth', 'token'], { timeoutMs: GH_LOGIN_READ_TIMEOUT_MS }));
  if (tokenAnswer === 'absent') return 'absent';
  return ghLoginAnswerOfViewerRead(await runGh(['api', 'user', '--silent'], { timeoutMs: GH_LOGIN_READ_TIMEOUT_MS }), tokenAnswer);
}

function createGithubSource({ userCredential, readGhLogin = readGhLoginFromGh, followGhLogin = followGhHostsFile, now = clock.nowMs }: GithubSourceDependencies): GithubSourceReader {
  let settledAnswer: { ghLogin: Exclude<GhLoginAnswer, 'unknown'>; readAtMs: number } | null = null;
  let pendingRead: Promise<GhLoginAnswer> | null = null;
  let loginChangeCount = 0;
  let isFollowingGhLogin = false;

  function forgetGhLogin(): void {
    loginChangeCount += 1;
    settledAnswer = null;
    pendingRead = null;
  }

  async function readAndKeepGhLogin(): Promise<GhLoginAnswer> {
    const changeCountAtRead = loginChangeCount;
    const ghLogin = await readGhLogin().catch((): GhLoginAnswer => 'unknown');
    if (ghLogin !== 'unknown' && changeCountAtRead === loginChangeCount) settledAnswer = { ghLogin, readAtMs: now() };
    return ghLogin;
  }

  function ghLoginNow(): Promise<GhLoginAnswer> {
    if (!isFollowingGhLogin) followGhLogin(forgetGhLogin);
    isFollowingGhLogin = true;
    if (settledAnswer !== null && now() - settledAnswer.readAtMs < GH_LOGIN_ANSWER_TTL_MS) return Promise.resolve(settledAnswer.ghLogin);
    const read = pendingRead ?? readAndKeepGhLogin().finally(() => {
      if (pendingRead === read) pendingRead = null;
    });
    pendingRead = read;
    return read;
  }

  async function current(): Promise<GithubSource> {
    if (await ghLoginNow() !== 'absent') return { kind: 'gh' };
    const userGrant = await userCredential().catch(() => null);
    if (userGrant === null) return { kind: 'none' };
    return { kind: 'connection', token: userGrant.token };
  }

  return { current };
}

export { GH_LOGIN_SOURCE, NO_GITHUB_SOURCE_TEXT, createGithubSource, ghLoginAnswerOfViewerRead };
export type { GithubSource, GithubSourceKind, GithubSourceReader };
