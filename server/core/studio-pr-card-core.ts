import { createHash } from 'node:crypto';
import { deriveStage } from '../../shared/contracts/my-pr-merge.ts';
import type { GithubPr } from '../../shared/contracts/github-prs.ts';
import type { MyPrStage } from '../../shared/contracts/my-prs.ts';
import type { BoxLine, BoxPullRequest, IconName, NOTE_TONES } from '../../shared/contracts/whiteboard.ts';
import { WHITEBOARD_LIMITS } from '../../shared/contracts/whiteboard.ts';

type NoteTone = (typeof NOTE_TONES)[number];

type PrCardFields = {
  title: string;
  icon: IconName;
  lines: BoxLine[];
  tone: NoteTone | null;
  pullRequest: BoxPullRequest;
};

const PR_CARD_HEIGHT = 150;
const PR_CARD_ID_PREFIX = 'pr-';
const REPO_HASH_HEX_LENGTH = 8;

const STAGE_TONES: Readonly<Record<MyPrStage, NoteTone | null>> = {
  merged: 'violet', draft: null, conflicts: 'pink', behind: 'yellow', 'checks-failing': 'pink',
  'changes-requested': 'yellow', 'unresolved-threads': 'yellow', 'checks-pending': 'blue',
  'needs-approval': 'blue', ready: 'green', unknown: null,
};

const CHECKS_TEXT: Readonly<Record<NonNullable<GithubPr['checks']['state']>, string>> = {
  SUCCESS: 'Passing', FAILURE: 'Failing', ERROR: 'Failing', PENDING: 'Running', EXPECTED: 'Running',
};

const REVIEW_TEXT: Readonly<Record<NonNullable<GithubPr['reviewDecision']>, string>> = {
  APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Needs review',
};

const SETTLED_STATES: ReadonlySet<GithubPr['state']> = new Set(['MERGED', 'CLOSED']);

function prCardBoxId(pr: Pick<GithubPr, 'repo' | 'number'>): string {
  const repoHash = createHash('sha256').update(pr.repo.toLowerCase()).digest('hex').slice(0, REPO_HASH_HEX_LENGTH);
  return `${PR_CARD_ID_PREFIX}${pr.number}-${repoHash}`;
}

function isSettledPr(pr: Pick<GithubPr, 'state'>): boolean {
  return SETTLED_STATES.has(pr.state);
}

function stateTextOf(pr: GithubPr): string {
  if (pr.state === 'MERGED') return 'Merged';
  if (pr.state === 'CLOSED') return 'Closed';
  return pr.isDraft ? 'Draft' : 'Open';
}

function checksTextOf(pr: GithubPr): string {
  return pr.checks.state === null ? 'None' : CHECKS_TEXT[pr.checks.state];
}

function reviewTextOf(pr: GithubPr): string {
  if (pr.reviewDecision === null) return pr.approvals > 0 ? 'Approved' : 'None';
  return REVIEW_TEXT[pr.reviewDecision];
}

function mergeTextOf(pr: GithubPr, stage: MyPrStage): string {
  if (isSettledPr(pr)) return 'Done';
  if (stage === 'conflicts') return 'Conflicts';
  if (stage === 'behind') return 'Behind base';
  if (pr.mergeable === 'MERGEABLE' && ['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(pr.mergeStateStatus)) return 'Ready';
  if (pr.mergeStateStatus === 'BLOCKED') return 'Blocked';
  return 'Unknown';
}

function prCardFieldsOf(pr: GithubPr): PrCardFields {
  const stage = deriveStage(pr);
  const tone = pr.state === 'CLOSED' ? null : STAGE_TONES[stage];
  const line = (key: string, text: string): BoxLine => ({ key, text, style: 'kv', muted: false });
  return {
    title: `#${pr.number} ${pr.title}`.slice(0, WHITEBOARD_LIMITS.title),
    icon: 'git-branch',
    lines: [line('State', stateTextOf(pr)), line('Checks', checksTextOf(pr)), line('Review', reviewTextOf(pr)), line('Merge', mergeTextOf(pr, stage))],
    tone,
    pullRequest: { url: pr.url },
  };
}

export { PR_CARD_HEIGHT, prCardBoxId, prCardFieldsOf };
export type { PrCardFields };
