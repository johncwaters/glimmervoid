export const TIP_LABEL_MAX_CHARS = 40;
export const TIP_DETAIL_MAX_CHARS = 96;

const ELLIPSIS = String.fromCharCode(0x2026);
const MIN_KEPT_SHARE_AT_WORD_BOUNDARY = 0.75;

export function clampTipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const prefix = text.slice(0, maxChars - 1);
  const wordBoundary = text[maxChars - 1] === ' ' ? prefix.length : prefix.lastIndexOf(' ');
  const isBoundaryCloseEnough = wordBoundary >= prefix.length * MIN_KEPT_SHARE_AT_WORD_BOUNDARY;
  return `${prefix.slice(0, isBoundaryCloseEnough ? wordBoundary : prefix.length).trimEnd()}${ELLIPSIS}`;
}
