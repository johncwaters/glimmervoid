const dirtySessionIds = new Set<string>();
let isFrameRequested = false;
let paintDirtySessions: (sessionIds: ReadonlySet<string>) => void = () => {};

export function setStatusPainter(painter: (sessionIds: ReadonlySet<string>) => void) {
  paintDirtySessions = painter;
}

export function markStatusDirty(sessionId: string) {
  dirtySessionIds.add(sessionId);
  if (isFrameRequested) return;
  isFrameRequested = true;
  requestAnimationFrame(flushStatusPaint);
}

function flushStatusPaint() {
  isFrameRequested = false;
  if (dirtySessionIds.size === 0) return;
  const sessionIds = new Set(dirtySessionIds);
  dirtySessionIds.clear();
  paintDirtySessions(sessionIds);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  flushStatusPaint();
});

function longestIncreasingRunIndices(positions: readonly number[]): Set<number> {
  const tailIndexByLength: number[] = [];
  const previousIndexOf: number[] = [];
  const tailPositionAt = (length: number) => positions[tailIndexByLength[length] ?? 0] ?? 0;
  positions.forEach((position, index) => {
    if (position < 0) return;
    let low = 0;
    let high = tailIndexByLength.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (tailPositionAt(middle) < position) {
        low = middle + 1;
        continue;
      }
      high = middle;
    }
    previousIndexOf[index] = low > 0 ? tailIndexByLength[low - 1] ?? -1 : -1;
    tailIndexByLength[low] = index;
  });
  const keptIndices = new Set<number>();
  let index = tailIndexByLength.at(-1) ?? -1;
  while (index >= 0) {
    keptIndices.add(index);
    index = previousIndexOf[index] ?? -1;
  }
  return keptIndices;
}

export function placeRowsInOrder(listEl: HTMLElement, orderedRowEls: readonly HTMLElement[]) {
  const domPositionByRow = new Map<Element, number>();
  Array.from(listEl.children).forEach((child, position) => {
    domPositionByRow.set(child, position);
  });
  const keptIndices = longestIncreasingRunIndices(orderedRowEls.map((row) => domPositionByRow.get(row) ?? -1));
  let nextRow: HTMLElement | null = null;
  for (let index = orderedRowEls.length - 1; index >= 0; index -= 1) {
    const row = orderedRowEls[index];
    if (!row) continue;
    if (!keptIndices.has(index)) listEl.insertBefore(row, nextRow);
    nextRow = row;
  }
}

export function writeTextIfChanged(element: HTMLElement, text: string) {
  if (element.textContent !== text) element.textContent = text;
}

export function writeHiddenIfChanged(element: HTMLElement, isHidden: boolean) {
  if (element.hidden !== isHidden) element.hidden = isHidden;
}

export function writeAttributeIfChanged(element: HTMLElement, name: string, value: string) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

export function writeDataIfChanged(element: HTMLElement, key: string, value: string) {
  if (element.dataset[key] !== value) element.dataset[key] = value;
}
