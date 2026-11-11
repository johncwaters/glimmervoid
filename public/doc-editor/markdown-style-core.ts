import { parseAtxHeading } from '../plan/plan-markdown-core.ts';

export type BlockStyle = 'h1' | 'h2' | 'h3' | 'quote' | 'list' | 'fence' | 'table' | 'plain';
export type InlineStyle = 'syntax' | 'strong' | 'emphasis' | 'code';
export type PreviewBlockKind = 'table' | 'fence' | 'image';

export interface PreviewBlock {
  kind: PreviewBlockKind;
  key: string;
  start: number;
  end: number;
}

interface InlineRun {
  start: number;
  end: number;
  style: InlineStyle;
}

const FENCE_MARKER = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_MARKER = /^ {0,3}#{1,6}[ \t]+/;
const QUOTE_MARKER = /^ {0,3}(?:>[ \t]?)+/;
const LIST_MARKER = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;
const TABLE_ROW = /^[ \t]*\|/;
const IMAGE_ONLY_LINE = /^[ \t]*!\[([^\]\n]*)\]\(\s*<?([^\s)<>]+)>?(?:\s+"[^"\n]*")?\s*\)[ \t]*$/;
const TABLE_DIVIDER_ROW = /^[ \t]*\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)*[ \t]*:?-{3,}:?[ \t]*\|?[ \t]*$/;
const INLINE_SPAN = /(`+)(?!`)(.+?)(?<!`)\1(?!`)|(\*\*|__)(?=\S)(.+?)(?<=\S)\3|(?<![\w*])([*_])(?=[^\s*_])(.+?)(?<=[^\s*_])\5(?![\w*])/g;
const HEADING_STYLES: readonly BlockStyle[] = ['plain', 'h1', 'h2', 'h3', 'h3', 'h3', 'h3'];
const BLOCK_MARKERS: Partial<Record<BlockStyle, RegExp>> = { h1: HEADING_MARKER, h2: HEADING_MARKER, h3: HEADING_MARKER, quote: QUOTE_MARKER, list: LIST_MARKER };

function lineBlockStyle(line: string): BlockStyle {
  const heading = parseAtxHeading(line, { overlongLine: 'truncate' });
  if (heading) return HEADING_STYLES[heading.level] ?? 'h3';
  if (QUOTE_MARKER.test(line)) return 'quote';
  if (LIST_MARKER.test(line)) return 'list';
  if (TABLE_ROW.test(line)) return 'table';
  return 'plain';
}

function closesFence(line: string, openFence: string) {
  const fence = FENCE_MARKER.exec(line)?.[1];
  return fence !== undefined && fence[0] === openFence[0] && fence.length >= openFence.length && line.trim() === fence;
}

export function blockStylesOf(source: string): BlockStyle[] {
  let openFence: string | null = null;
  return source.split('\n').map((line): BlockStyle => {
    if (openFence !== null) {
      if (closesFence(line, openFence)) openFence = null;
      return 'fence';
    }
    openFence = FENCE_MARKER.exec(line)?.[1] ?? null;
    if (openFence !== null) return 'fence';
    return lineBlockStyle(line);
  });
}

function wrappedRuns(start: number, end: number, markerLength: number, style: InlineStyle): InlineRun[] {
  return [
    { start, end: start + markerLength, style: 'syntax' },
    { start: start + markerLength, end: end - markerLength, style },
    { start: end - markerLength, end, style: 'syntax' },
  ];
}

export function inlineRunsOf(text: string, block: BlockStyle, startsLine: boolean): InlineRun[] {
  if (block === 'fence' || block === 'table') return [];
  const runs: InlineRun[] = [];
  const blockMarker = startsLine ? BLOCK_MARKERS[block]?.exec(text)?.[0] : undefined;
  if (blockMarker) runs.push({ start: 0, end: blockMarker.length, style: 'syntax' });
  for (const match of text.matchAll(INLINE_SPAN)) {
    const start = match.index;
    const end = start + match[0].length;
    const [, codeFence, , strongMarker, , emphasisMarker] = match;
    if (codeFence) runs.push(...wrappedRuns(start, end, codeFence.length, 'code'));
    if (strongMarker) runs.push(...wrappedRuns(start, end, strongMarker.length, 'strong'));
    if (emphasisMarker) runs.push(...wrappedRuns(start, end, emphasisMarker.length, 'emphasis'));
  }
  return runs;
}

interface MarkdownImage {
  alt: string;
  src: string;
}

export function markdownImageOf(line: string): MarkdownImage | null {
  const imageMatch = IMAGE_ONLY_LINE.exec(line);
  if (!imageMatch) return null;
  return { alt: imageMatch[1] ?? '', src: imageMatch[2] ?? '' };
}

function previewKindOfLine(block: BlockStyle | undefined, line: string): PreviewBlockKind | null {
  if (block === 'table' || block === 'fence') return block;
  if (block === 'plain' && IMAGE_ONLY_LINE.test(line)) return 'image';
  return null;
}

function isBlockWhole(kind: PreviewBlockKind, blockLines: readonly string[]) {
  if (kind === 'image') return blockLines.length === 1;
  if (blockLines.length < 2) return false;
  return kind === 'fence' || TABLE_DIVIDER_ROW.test(blockLines[1] ?? '');
}

export function previewBlocksOf(source: string): PreviewBlock[] {
  const lines = source.split('\n');
  const blockStyles = blockStylesOf(source);
  const lineStarts: number[] = [];
  let nextLineStart = 0;
  for (const line of lines) {
    lineStarts.push(nextLineStart);
    nextLineStart += line.length + 1;
  }
  const blocks: PreviewBlock[] = [];
  const countByKind: Record<PreviewBlockKind, number> = { table: 0, fence: 0, image: 0 };
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const kind = previewKindOfLine(blockStyles[lineIndex], lines[lineIndex] ?? '');
    const firstLineIndex = lineIndex;
    lineIndex += 1;
    if (kind === null) continue;
    while (kind !== 'image' && blockStyles[lineIndex] === kind) lineIndex += 1;
    const lastLineIndex = lineIndex - 1;
    if (!isBlockWhole(kind, lines.slice(firstLineIndex, lineIndex))) continue;
    const start = lineStarts[firstLineIndex] ?? 0;
    const end = (lineStarts[lastLineIndex] ?? 0) + (lines[lastLineIndex]?.length ?? 0);
    blocks.push({ kind, key: `${kind}-${countByKind[kind]}`, start, end });
    countByKind[kind] += 1;
  }
  return blocks;
}
