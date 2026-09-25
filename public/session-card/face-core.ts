export type SessionCardFace = 'terminal' | 'plan';

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
