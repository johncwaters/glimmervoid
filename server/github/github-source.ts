import { clock } from '../../shared/clock.ts';
import { runGh } from '../git/git-exec.ts';

type GithubSource = { kind: 'gh' } | { kind: 'connection'; token: string } | { kind: 'none' };
type GithubSourceKind = GithubSource['kind'];
type GithubSourceReader = { current(): Promise<GithubSource> };
type GhLoginAnswer = 'present' | 'absent' | 'unknown';

interface GithubSourceDependencies {
  userCredential: () => Promise<{ token: string } | null>;
  readGhLogin?: () => Promise<GhLoginAnswer>;
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

async function readGhLoginFromGh(): Promise<GhLoginAnswer> {
  const tokenAnswer = ghLoginAnswerOf(await runGh(['auth', 'token'], { timeoutMs: GH_LOGIN_READ_TIMEOUT_MS }));
  if (tokenAnswer === 'absent') return 'absent';
  return ghLoginAnswerOfViewerRead(await runGh(['api', 'user', '--silent'], { timeoutMs: GH_LOGIN_READ_TIMEOUT_MS }), tokenAnswer);
}

function createGithubSource({ userCredential, readGhLogin = readGhLoginFromGh, now = clock.nowMs }: GithubSourceDependencies): GithubSourceReader {
  let settledAnswer: { ghLogin: Exclude<GhLoginAnswer, 'unknown'>; readAtMs: number } | null = null;
  let pendingRead: Promise<GhLoginAnswer> | null = null;

  async function readAndKeepGhLogin(): Promise<GhLoginAnswer> {
    const ghLogin = await readGhLogin().catch((): GhLoginAnswer => 'unknown');
    if (ghLogin !== 'unknown') settledAnswer = { ghLogin, readAtMs: now() };
    return ghLogin;
  }

  function ghLoginNow(): Promise<GhLoginAnswer> {
    if (settledAnswer !== null && now() - settledAnswer.readAtMs < GH_LOGIN_ANSWER_TTL_MS) return Promise.resolve(settledAnswer.ghLogin);
    pendingRead ??= readAndKeepGhLogin().finally(() => {
      pendingRead = null;
    });
    return pendingRead;
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
