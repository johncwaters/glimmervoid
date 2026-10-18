import type { LinkedPr, MyPr, MyPrsStatus } from '#shared/contracts/my-prs.ts';
import { tierForTone } from '../signal-core.ts';
import type { Signal } from '../signal-core.ts';
import { comparablePrKey, stageIcon, stageLabel, stageTone } from './my-prs-view-core.ts';

export type MyPrsByKey = ReadonlyMap<string, MyPr>;

export interface SessionPrChip extends Signal {
  url: string;
}

const NO_PRS: MyPrsByKey = new Map();

const STATE_RANK: Readonly<Record<MyPr['state'], number>> = { OPEN: 0, MERGED: 1, CLOSED: 2 };

export function nextMyPrsByKey(previous: MyPrsByKey, status: MyPrsStatus | null): MyPrsByKey {
  if (!status) return previous;
  if (!status.configured) return NO_PRS;
  if (status.error) return previous;
  return new Map(status.prs.map((pr) => [comparablePrKey(pr), pr]));
}

function stateRank(pr: MyPr | undefined): number {
  return pr ? STATE_RANK[pr.state] : STATE_RANK.OPEN;
}

function toChip(link: LinkedPr, pr: MyPr | undefined): SessionPrChip {
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

export function sessionPrSignals(links: readonly LinkedPr[], prsByKey: MyPrsByKey): SessionPrChip[] {
  const linkedPrs = links.map((link) => ({ link, pr: prsByKey.get(comparablePrKey(link)) }));
  linkedPrs.sort((left, right) => stateRank(left.pr) - stateRank(right.pr) || right.link.linkedAt - left.link.linkedAt);
  return linkedPrs.map(({ link, pr }) => toChip(link, pr));
}
