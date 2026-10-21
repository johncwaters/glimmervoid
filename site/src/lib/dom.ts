export function createElement(tagName: string, className: string, text = ''): HTMLElement {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function runFramesWhileVisible(element: Element, holdMsByFrame: readonly number[], showFrame: (frameIndex: number) => void): void {
  if (prefersReducedMotion() || holdMsByFrame.length < 2) return;
  let isOnScreen = false;
  let frameIndex = 0;
  let pendingAdvance: ReturnType<typeof setTimeout> | null = null;
  const scheduleAdvance = () => {
    if (pendingAdvance !== null || !isOnScreen || document.hidden) return;
    pendingAdvance = setTimeout(advance, holdMsByFrame[frameIndex]);
  };
  const advance = () => {
    pendingAdvance = null;
    if (!isOnScreen || document.hidden) return;
    frameIndex = (frameIndex + 1) % holdMsByFrame.length;
    showFrame(frameIndex);
    scheduleAdvance();
  };
  new IntersectionObserver(([entry]) => {
    isOnScreen = entry.isIntersecting;
    scheduleAdvance();
  }).observe(element);
  document.addEventListener('visibilitychange', scheduleAdvance);
}

export function markWhileOnScreen(element: HTMLElement): void {
  new IntersectionObserver(([entry]) => {
    element.dataset.onScreen = String(entry.isIntersecting);
  }).observe(element);
}

export function hasTextSelectedIn(element: Element): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.toString().trim() === '') return false;
  return element.contains(selection.anchorNode) || element.contains(selection.focusNode);
}

export function copyText(text: string): Promise<boolean> {
  if (!navigator.clipboard) return Promise.resolve(false);
  return navigator.clipboard.writeText(text).then(() => true, () => false);
}
