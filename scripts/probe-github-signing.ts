import { z } from 'zod';

const USAGE = 'Usage: node scripts/probe-github-signing.ts <owner/repo> <commit sha>. Set GITHUB_TOKEN in the environment for a private repository.';
const REPOSITORY_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/;
const CommitVerification = z.object({ commit: z.object({ verification: z.object({ verified: z.boolean(), reason: z.string() }) }) });

async function probeGithubSigning(repository: string, commitSha: string, token: string | undefined): Promise<number> {
  const response = await fetch(`https://api.github.com/repos/${repository}/commits/${commitSha}`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    console.error(`GitHub answered HTTP ${response.status} for ${repository}@${commitSha}.`);
    return 2;
  }
  const parsed = CommitVerification.safeParse(await response.json());
  if (!parsed.success) {
    console.error('GitHub answered without a commit verification block.');
    return 2;
  }
  const { verified, reason } = parsed.data.commit.verification;
  console.log(JSON.stringify({ repository, commit: commitSha, verified, reason }));
  return verified ? 0 : 1;
}

const [repository = '', commitSha = ''] = process.argv.slice(2);
if (!REPOSITORY_PATTERN.test(repository) || !COMMIT_SHA_PATTERN.test(commitSha)) {
  console.error(USAGE);
  process.exit(2);
}
process.exitCode = await probeGithubSigning(repository, commitSha, process.env.GITHUB_TOKEN);
