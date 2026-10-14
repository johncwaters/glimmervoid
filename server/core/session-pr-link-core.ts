import { isRecord } from '../../shared/coerce.ts';
import { LinkedPr } from '../../shared/contracts/my-prs.ts';
import type { MyPr, MyPrsStatus } from '../../shared/contracts/my-prs.ts';

const PR_LINK_HOOK_EVENT = 'posttooluse';
const PR_LINK_TOOL_NAME = 'Bash';
const LINKING_PR_ACTIONS: ReadonlySet<string> = new Set(['created', 'edited']);
const KEYED_PR_ACTIONS = ['created', 'edited', 'commented'] as const;
const GITHUB_HOST = 'github.com';

interface PrLinkSession {
  ephemeral: boolean;
}

interface PrOperation {
  action: string;
  details: Record<string, unknown>;
}

interface PullRequestIdentity {
  repo: string;
  number: number;
  url: string;
}

function shouldLinkSession(session: PrLinkSession): boolean {
  return !session.ephemeral;
}

function prOperationOf(gitOperation: Record<string, unknown>): PrOperation | null {
  const pr = gitOperation.pr;
  if (!isRecord(pr)) return null;
  if (typeof pr.action === 'string') return { action: pr.action, details: pr };
  const keyedAction = KEYED_PR_ACTIONS.find((action) => isRecord(pr[action]));
  if (!keyedAction) return null;
  const keyedDetails = pr[keyedAction];
  return isRecord(keyedDetails) ? { action: keyedAction, details: keyedDetails } : null;
}

function identityFromUrl(rawUrl: unknown): PullRequestIdentity | null {
  if (typeof rawUrl !== 'string' || !URL.canParse(rawUrl)) return null;
  const parsedUrl = new URL(rawUrl);
  if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== GITHUB_HOST) return null;
  const [owner, name, pullSegment, numberText] = parsedUrl.pathname.split('/').filter(Boolean);
  if (pullSegment !== 'pull' || !owner || !name || !numberText || !/^[1-9][0-9]*$/.test(numberText)) return null;
  const repo = `${owner}/${name}`;
  const number = Number(numberText);
  return { repo, number, url: `https://${GITHUB_HOST}/${repo}/pull/${number}` };
}

function identityFromRepoAndNumber(details: Record<string, unknown>): PullRequestIdentity | null {
  const repo = typeof details.repo === 'string' ? details.repo : details.repository;
  const number = details.number;
  if (typeof repo !== 'string' || typeof number !== 'number') return null;
  return { repo, number, url: `https://${GITHUB_HOST}/${repo}/pull/${number}` };
}

function hookPrLink(event: string, payload: Record<string, unknown>, nowMs: number): LinkedPr | null {
  if (event.toLowerCase() !== PR_LINK_HOOK_EVENT) return null;
  if (payload.tool_name !== PR_LINK_TOOL_NAME) return null;
  const toolResponse = payload.tool_response;
  if (!isRecord(toolResponse) || !isRecord(toolResponse.gitOperation)) return null;
  const operation = prOperationOf(toolResponse.gitOperation);
  if (!operation || !LINKING_PR_ACTIONS.has(operation.action)) return null;
  const identity = identityFromUrl(operation.details.url) ?? identityFromRepoAndNumber(operation.details);
  if (!identity) return null;
  const parsed = LinkedPr.safeParse({ ...identity, source: 'hook', linkedAt: nowMs });
  return parsed.success ? parsed.data : null;
}

const SAFE_BASE_REF_NAME_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+(?<![./])$/;

interface ShaJoinCandidate {
  repo: string;
  number: number;
  url: string;
  baseRefName: string;
  headRefOid: string;
}

interface CommitsAheadOfBase {
  baseRefName: string;
  commitShas: readonly string[];
}

interface ShaJoinPartition {
  matched: ShaJoinCandidate[];
  unmatched: ShaJoinCandidate[];
}

function isUsableMyPrsStatus(status: Pick<MyPrsStatus, 'configured' | 'error'>): boolean {
  return status.configured && !status.error;
}

function openPrCandidatesByRepo(prs: readonly MyPr[]): Map<string, ShaJoinCandidate[]> {
  const candidatesByRepo = new Map<string, ShaJoinCandidate[]>();
  for (const pr of prs) {
    if (pr.state !== 'OPEN' || !SAFE_BASE_REF_NAME_RE.test(pr.baseRefName)) continue;
    const repoKey = pr.repo.toLowerCase();
    const candidate = { repo: pr.repo, number: pr.number, url: pr.url, baseRefName: pr.baseRefName, headRefOid: pr.headRefOid.toLowerCase() };
    candidatesByRepo.set(repoKey, [...(candidatesByRepo.get(repoKey) ?? []), candidate]);
  }
  return candidatesByRepo;
}

function candidatesForRepo(candidatesByRepo: ReadonlyMap<string, ShaJoinCandidate[]>, repoSlug: string | null): ShaJoinCandidate[] {
  if (!repoSlug) return [];
  return candidatesByRepo.get(repoSlug.toLowerCase()) ?? [];
}

function distinctBaseRefNames(candidates: readonly ShaJoinCandidate[]): string[] {
  return [...new Set(candidates.map((candidate) => candidate.baseRefName))];
}

function commitsAheadArgs(baseRefName: string): string[] {
  return ['rev-list', 'HEAD', '--not', `refs/remotes/origin/${baseRefName}`, '--'];
}

function parseRevListShas(revListOutput: string): string[] {
  return revListOutput.split('\n').map((line) => line.trim().toLowerCase()).filter(Boolean);
}

function partitionByCommitsAhead(candidates: readonly ShaJoinCandidate[], commitsAhead: readonly CommitsAheadOfBase[]): ShaJoinPartition {
  const commitShasByBase = new Map(commitsAhead.map(({ baseRefName, commitShas }) => [baseRefName, new Set(commitShas)]));
  const matched: ShaJoinCandidate[] = [];
  const unmatched: ShaJoinCandidate[] = [];
  for (const candidate of candidates) {
    const commitShas = commitShasByBase.get(candidate.baseRefName);
    if (!commitShas || commitShas.size === 0) continue;
    (commitShas.has(candidate.headRefOid) ? matched : unmatched).push(candidate);
  }
  return { matched, unmatched };
}

function shaPrLink(candidate: ShaJoinCandidate, nowMs: number): LinkedPr | null {
  const parsed = LinkedPr.safeParse({ repo: candidate.repo, number: candidate.number, url: candidate.url, source: 'sha', linkedAt: nowMs });
  return parsed.success ? parsed.data : null;
}

export {
  candidatesForRepo, commitsAheadArgs, distinctBaseRefNames, hookPrLink, isUsableMyPrsStatus, openPrCandidatesByRepo,
  parseRevListShas, partitionByCommitsAhead, shaPrLink, shouldLinkSession,
};
export type { CommitsAheadOfBase, PrLinkSession, ShaJoinCandidate };
