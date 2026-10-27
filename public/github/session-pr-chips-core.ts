import { comparablePrKey } from '#shared/contracts/github-prs.ts';
import type { GithubPr } from '#shared/contracts/github-prs.ts';
import type { LinkedPr, MyPr } from '#shared/contracts/my-prs.ts';
import { tierForTone } from '../signal-core.ts';
import type { Signal } from '../signal-core.ts';
import { myPrFromGithubPr } from '#shared/my-pr-merge.ts';
import { stageIcon, stageLabel, stageTone } from './github-store-core.ts';

export interface SessionPrChip extends Signal {
  url: string;
}

const STATE_RANK: Readonly<Record<MyPr['state'], number>> = { OPEN: 0, MERGED: 1, CLOSED: 2 };

function stateRank(pr: Pick<MyPr, 'state'> | undefined): number {
  return pr ? STATE_RANK[pr.state] : STATE_RANK.OPEN;
}

function toChip(link: LinkedPr, pr: Pick<MyPr, 'state' | 'stage' | 'url' | 'title'> | undefined): SessionPrChip {
  const key = `${link.repo}#${link.number}`;
  const text = `#${link.number}`;
  if (!pr) return { key, text, url: link.url, hoverText: link.repo, look: null, tier: tierForTone(undefined) };
  const tone = stageTone(pr.stage);
  return {
    key,
    text,
    url: pr.url,
    hoverText: `${link.repo}: ${pr.title} (${stageLabel(pr.stage)})`,
    look: { icon: stageIcon(pr.stage), tone },
    tier: tierForTone(tone),
  };
}

export function sessionPrSignals(links: readonly LinkedPr[], findGithubPr: (key: string) => GithubPr | undefined): SessionPrChip[] {
  const linkedPrs = links.map((link) => {
    const key = comparablePrKey(link);
    const canonicalPr = findGithubPr(key);
    const pr = canonicalPr ? myPrFromGithubPr(canonicalPr) : undefined;
    return { link, pr };
  });
  linkedPrs.sort((left, right) => stateRank(left.pr) - stateRank(right.pr) || right.link.linkedAt - left.link.linkedAt);
  return linkedPrs.map(({ link, pr }) => toChip(link, pr));
}
