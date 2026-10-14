import type { LinkedPr, MyPr, MyPrsStatus } from '#shared/contracts/my-prs.ts';
import type { PrStatusIcon } from './pr-status-icon-core.ts';
import type { StateTone } from '../state-tone-core.ts';
import { comparablePrKey, stageIcon, stageLabel, stageTone } from './my-prs-view-core.ts';

const VISIBLE_SESSION_PR_CHIPS = 2;

export type MyPrsByKey = ReadonlyMap<string, MyPr>;

interface SessionPrChipStage { icon: PrStatusIcon; tone: StateTone; label: string }

export interface SessionPrChip {
  key: string;
  numberText: string;
  url: string;
  hoverText: string;
  stage: SessionPrChipStage | null;
}

interface SessionPrChipsView {
  chips: SessionPrChip[];
  overflowCount: number;
  overflowHoverText: string;
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
  const numberText = `#${link.number}`;
  if (!pr) return { key, numberText, url: link.url, hoverText: link.repo, stage: null };
  return {
    key,
    numberText,
    url: pr.url,
    hoverText: `${link.repo}: ${pr.title} (${stageLabel(pr.stage)})`,
    stage: { icon: stageIcon(pr.stage), tone: stageTone(pr.stage), label: stageLabel(pr.stage) },
  };
}

export function buildSessionPrChips(links: readonly LinkedPr[], prsByKey: MyPrsByKey): SessionPrChipsView {
  const ranked = links.map((link) => ({ link, pr: prsByKey.get(comparablePrKey(link)) }));
  ranked.sort((left, right) => stateRank(left.pr) - stateRank(right.pr) || right.link.linkedAt - left.link.linkedAt);
  const allChips = ranked.map(({ link, pr }) => toChip(link, pr));
  const hiddenChips = allChips.slice(VISIBLE_SESSION_PR_CHIPS);
  return {
    chips: allChips.slice(0, VISIBLE_SESSION_PR_CHIPS),
    overflowCount: hiddenChips.length,
    overflowHoverText: hiddenChips.map((chip) => `${chip.numberText} ${chip.hoverText}`).join('\n'),
  };
}
