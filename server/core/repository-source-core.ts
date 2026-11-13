import path from 'node:path';
import { REPO_SLUG_RE } from '../../shared/contracts/github-ids.ts';

type RepositorySource = { ok: true; url: string; repoName: string; isGithubHttps: boolean; isSsh: boolean } | { ok: false; error: string };
type ParsedRepositorySource = Extract<RepositorySource, { ok: true }>;
type RootCheckouts = { root: string; hasGitCheckout: boolean };

const DEFAULT_REPO_ROOT_FOLDER = 'glimmervoid';
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCP_LIKE_RE = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):([A-Za-z0-9._~/-]+)$/;
const UNSAFE_CHARACTER_RE = /[\s\u0000-\u001f\u007f]/;

const CLONE_SAFETY_ARGS: readonly string[] = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always'];

function refusal(text: string): RepositorySource {
  return { ok: false, error: `${text} is not a repository URL: paste an https or ssh clone URL, such as https://github.com/owner/repo, or owner/repo for GitHub` };
}

function repoNameOf(repoPath: string): string | null {
  const segments = repoPath.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  const repoName = (segments.at(-1) ?? '').replace(/\.git$/, '');
  if (!REPO_NAME_RE.test(repoName)) return null;
  return repoName;
}

function sourceFromParts(text: string, url: string, repoPath: string, flags: { isGithubHttps: boolean; isSsh: boolean }): RepositorySource {
  const repoName = repoNameOf(repoPath);
  if (repoName === null) return refusal(text);
  return { ok: true, url, repoName, ...flags };
}

function parseUrlSource(text: string): RepositorySource {
  if (!URL.canParse(text)) return refusal(text);
  const parsed = new URL(text);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') return refusal(text);
  if (parsed.password !== '' || parsed.search !== '' || parsed.hash !== '' || parsed.hostname === '') return refusal(text);
  const isSsh = parsed.protocol === 'ssh:';
  if (!isSsh && parsed.username !== '') return refusal(text);
  const repoPath = parsed.pathname.replace(/\/+$/, '');
  return sourceFromParts(text, `${parsed.protocol}//${parsed.username ? `${parsed.username}@` : ''}${parsed.host}${repoPath}`, repoPath, { isGithubHttps: !isSsh && parsed.hostname === 'github.com', isSsh });
}

function parseRepositorySource(rawText: string): RepositorySource {
  const text = rawText.trim();
  if (text === '' || text.startsWith('-') || UNSAFE_CHARACTER_RE.test(text)) return refusal(JSON.stringify(rawText));
  if (REPO_SLUG_RE.test(text)) return sourceFromParts(text, `https://github.com/${text.replace(/\.git$/, '')}`, text, { isGithubHttps: true, isSsh: false });
  const scpLike = SCP_LIKE_RE.exec(text);
  if (scpLike) {
    if (scpLike[3].startsWith('-')) return refusal(text);
    return sourceFromParts(text, text, scpLike[3], { isGithubHttps: false, isSsh: true });
  }
  return parseUrlSource(text);
}

function defaultRepoRootOf(homeDir: string): string {
  return path.join(homeDir, DEFAULT_REPO_ROOT_FOLDER);
}

function cloneRootOf(roots: readonly RootCheckouts[], defaultRoot: string): string {
  return roots.find((root) => root.hasGitCheckout)?.root ?? roots[0]?.root ?? defaultRoot;
}

function githubAuthHeaderOf(token: string): string {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
}

function cloneEnvOf(source: ParsedRepositorySource, githubToken: string | null, inheritedSshCommand: string | undefined): Record<string, string> {
  if (source.isSsh) return inheritedSshCommand === undefined ? { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' } : {};
  if (!source.isGithubHttps || !githubToken) return {};
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: githubAuthHeaderOf(githubToken) };
}

export { CLONE_SAFETY_ARGS, cloneEnvOf, cloneRootOf, defaultRepoRootOf, parseRepositorySource };
export type { RootCheckouts };
