export type SessionCardFace = 'terminal' | 'plan' | 'shown';

export function decidePlanHeaderAction({ hasPlan, isBorrowed, face }: {
  hasPlan: boolean;
  isBorrowed: boolean;
  face: SessionCardFace;
}): 'hidden' | 'face' | 'navigate' {
  if (!hasPlan || face === 'plan') return 'hidden';
  if (isBorrowed) return 'face';
  return 'navigate';
}
