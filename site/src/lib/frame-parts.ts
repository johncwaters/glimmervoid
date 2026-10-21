export interface FramePartAttributes {
  'data-from': number;
  'data-until'?: number;
  'data-on': string;
}

function isShownAt(frameIndex: number, fromFrame: number, untilFrame: number | undefined): boolean {
  return frameIndex >= fromFrame && (untilFrame === undefined || frameIndex < untilFrame);
}

export function framePart(fromFrame: number, untilFrame?: number): FramePartAttributes {
  return { 'data-from': fromFrame, 'data-until': untilFrame, 'data-on': String(isShownAt(0, fromFrame, untilFrame)) };
}

export function showFrameParts(root: Element, frameIndex: number): void {
  for (const part of root.querySelectorAll<HTMLElement>('[data-from]')) {
    const untilFrame = part.dataset.until === undefined ? undefined : Number(part.dataset.until);
    part.dataset.on = String(isShownAt(frameIndex, Number(part.dataset.from), untilFrame));
  }
}
