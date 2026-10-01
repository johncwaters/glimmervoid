export function createElement(tagName: string, className: string, text = ''): HTMLElement {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export type TimelineStep = readonly [atMs: number, step: () => void];

export function runTimeline(timeline: readonly TimelineStep[], loopMs: number, reset: () => void): void {
  const startCycle = () => {
    reset();
    for (const [atMs, step] of timeline) setTimeout(step, atMs);
    setTimeout(startCycle, loopMs);
  };
  startCycle();
}
