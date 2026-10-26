type RovingOrientation = 'horizontal' | 'vertical' | 'both';

const STEP_BY_KEY_BY_ORIENTATION: Readonly<Record<RovingOrientation, ReadonlyMap<string, number>>> = {
  horizontal: new Map([['ArrowLeft', -1], ['ArrowRight', 1]]),
  vertical: new Map([['ArrowUp', -1], ['ArrowDown', 1]]),
  both: new Map([['ArrowLeft', -1], ['ArrowRight', 1], ['ArrowUp', -1], ['ArrowDown', 1]]),
};

export function wrapIndex(currentIndex: number, step: number, count: number) {
  if (currentIndex < 0) return step > 0 ? 0 : count - 1;
  return (((currentIndex + step) % count) + count) % count;
}

export function nextRovingIndex(key: string, currentIndex: number, count: number, orientation: RovingOrientation): number | null {
  if (count === 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const step = STEP_BY_KEY_BY_ORIENTATION[orientation].get(key);
  if (step === undefined) return null;
  return wrapIndex(currentIndex, step, count);
}
