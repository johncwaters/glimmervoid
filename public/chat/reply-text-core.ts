export interface InlineSpan {
  style: 'plain' | 'code' | 'strong';
  text: string;
}

export type ReplyBlock =
  | { kind: 'paragraph'; spans: InlineSpan[] }
  | { kind: 'heading'; spans: InlineSpan[] }
  | { kind: 'list'; isOrdered: boolean; start: number; items: InlineSpan[][] }
  | { kind: 'code'; text: string };

type LineBlock =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'heading'; line: string }
  | { kind: 'list'; isOrdered: boolean; start: number; itemLines: string[] }
  | { kind: 'code'; lines: string[] };

const FENCE = /^\s*```/;
const HEADING = /^#{1,6}\s+(.*)$/;
const UNORDERED_ITEM = /^\s*[-*+]\s+(.*)$/;
const ORDERED_ITEM = /^\s*(\d+)[.)]\s+(.*)$/;
const INLINE_TOKEN = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*/g;

function inlineSpansOf(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let plainStart = 0;
  for (const match of text.matchAll(INLINE_TOKEN)) {
    if (match.index > plainStart) spans.push({ style: 'plain', text: text.slice(plainStart, match.index) });
    const codeText = match[2];
    spans.push(codeText === undefined ? { style: 'strong', text: match[3] ?? '' } : { style: 'code', text: codeText });
    plainStart = match.index + match[0].length;
  }
  if (plainStart < text.length) spans.push({ style: 'plain', text: text.slice(plainStart) });
  return spans;
}

function listItemOf(line: string): { isOrdered: boolean; number: number; text: string } | null {
  const unordered = UNORDERED_ITEM.exec(line);
  if (unordered) return { isOrdered: false, number: 1, text: unordered[1] ?? '' };
  const ordered = ORDERED_ITEM.exec(line);
  if (ordered) return { isOrdered: true, number: Number(ordered[1]), text: ordered[2] ?? '' };
  return null;
}

function isBlankParagraph(block: LineBlock | undefined): boolean {
  return block?.kind === 'paragraph' && block.lines.length === 0;
}

function listContinuedAcrossBlank(blocks: LineBlock[], isOrdered: boolean): Extract<LineBlock, { kind: 'list' }> | null {
  const current = blocks[blocks.length - 1];
  const listCandidate = isBlankParagraph(current) ? blocks[blocks.length - 2] : current;
  if (listCandidate?.kind !== 'list' || listCandidate.isOrdered !== isOrdered) return null;
  if (isBlankParagraph(current)) blocks.pop();
  return listCandidate;
}

function appendLine(blocks: LineBlock[], line: string): void {
  const current = blocks[blocks.length - 1];
  if (current?.kind === 'code') {
    current.lines.push(line);
    return;
  }
  if (line.trim().length === 0) {
    blocks.push({ kind: 'paragraph', lines: [] });
    return;
  }
  const heading = HEADING.exec(line);
  if (heading) {
    blocks.push({ kind: 'heading', line: heading[1] ?? '' });
    return;
  }
  const listItem = listItemOf(line);
  const continuedList = listItem ? listContinuedAcrossBlank(blocks, listItem.isOrdered) : null;
  if (listItem && continuedList) {
    continuedList.itemLines.push(listItem.text);
    return;
  }
  if (listItem) {
    blocks.push({ kind: 'list', isOrdered: listItem.isOrdered, start: listItem.number, itemLines: [listItem.text] });
    return;
  }
  if (current?.kind === 'list' && /^\s/.test(line)) {
    current.itemLines[current.itemLines.length - 1] += ` ${line.trim()}`;
    return;
  }
  if (current?.kind === 'paragraph') {
    current.lines.push(line);
    return;
  }
  blocks.push({ kind: 'paragraph', lines: [line] });
}

function lineBlocksOf(text: string): LineBlock[] {
  const blocks: LineBlock[] = [];
  for (const line of text.split('\n')) {
    const current = blocks[blocks.length - 1];
    if (FENCE.test(line) && current?.kind === 'code') {
      blocks.push({ kind: 'paragraph', lines: [] });
      continue;
    }
    if (FENCE.test(line)) {
      blocks.push({ kind: 'code', lines: [] });
      continue;
    }
    appendLine(blocks, line);
  }
  return blocks;
}

function replyBlockOf(block: LineBlock): ReplyBlock | null {
  if (block.kind === 'code') return { kind: 'code', text: block.lines.join('\n') };
  if (block.kind === 'heading') return { kind: 'heading', spans: inlineSpansOf(block.line) };
  if (block.kind === 'list') return { kind: 'list', isOrdered: block.isOrdered, start: block.start, items: block.itemLines.map(inlineSpansOf) };
  if (block.lines.length === 0) return null;
  return { kind: 'paragraph', spans: inlineSpansOf(block.lines.join('\n')) };
}

export function replyBlocksOf(text: string): ReplyBlock[] {
  return lineBlocksOf(text).map(replyBlockOf).filter((block): block is ReplyBlock => block !== null);
}
