export type SessionCardFace = 'terminal' | 'plan' | 'conversation';

const NEED_WORDS_BY_PROMPT_KIND: ReadonlyMap<string, string> = new Map([
  ['plan', 'Plan ready'],
  ['permission', 'Needs permission'],
]);

export function promptKindNeedWords(pendingPromptKind: string): string {
  return NEED_WORDS_BY_PROMPT_KIND.get(pendingPromptKind) ?? 'Needs input';
}

export function preferredBorrowedFace({
  hasPlan,
  pendingPromptKind,
  hasOpenReview,
  hasApprovedReview = false,
}: {
  hasPlan: boolean;
  pendingPromptKind: string | null;
  hasOpenReview: boolean;
  hasApprovedReview?: boolean;
}): SessionCardFace {
  if (!hasPlan) return 'terminal';
  if (hasOpenReview) return 'plan';
  if (pendingPromptKind === 'plan' && !hasApprovedReview) return 'plan';
  return 'terminal';
}

export function decidePlanHeaderAction({ hasPlan, isBorrowed, face }: {
  hasPlan: boolean;
  isBorrowed: boolean;
  face: SessionCardFace;
}): 'hidden' | 'face' | 'navigate' {
  if (!hasPlan || face === 'plan') return 'hidden';
  if (isBorrowed) return 'face';
  return 'navigate';
}
