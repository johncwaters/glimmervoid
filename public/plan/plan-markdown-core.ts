import { parseAtxHeading } from '#shared/contracts/plan-review.ts';
import { normalizedHttpUrl } from '#shared/http-url.ts';
import { findUrls } from '../session-card/link-detect-core.ts';

export type PlanInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'emphasis'; children: PlanInline[] }
  | { type: 'strong'; children: PlanInline[] }
  | { type: 'link'; href: string; children: PlanInline[] };

export interface PlanListItem {
  children: PlanBlock[];
}

export type PlanBlock =
  | { type: 'heading'; level: number; id: string; children: PlanInline[] }
  | { type: 'paragraph'; children: PlanInline[] }
  | { type: 'list'; ordered: boolean; items: PlanListItem[] }
  | { type: 'code'; language: string; text: string }
  | { type: 'table'; header: PlanInline[][]; rows: PlanInline[][][] }
  | { type: 'blockquote'; blocks: PlanBlock[] }
  | { type: 'rule' };

interface ParseContext {
  slugCounts: Map<string, number>;
}

interface ListLine {
  indent: number;
  ordered: boolean;
  content: string;
}

interface PlanLinkSpan {
  label: string;
  target: string;
  end: number;
}

const MAX_LINK_TARGET_PAREN_DEPTH = 2;
const MAX_BLOCK_NESTING_DEPTH = 8;

const fencePattern = /^ {0,3}(`{3,}|~{3,})([^`]*)$/;
const listPattern = /^(\s*)(?:([-+*])|(\d+)[.)])\s+(.+)$/;
const rulePattern = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const tableDividerCellPattern = /^:?-{3,}:?$/;
const fenceLanguagePattern = /^[A-Za-z0-9_+#.-]{1,32}$/;

function headingLine(line: string) {
  return parseAtxHeading(line, { overlongLine: 'reject' });
}

function fenceLanguage(infoString: string): string {
  const firstToken = infoString.trim().split(/\s+/)[0] ?? '';
  return fenceLanguagePattern.test(firstToken) ? firstToken : '';
}

function appendText(nodes: PlanInline[], text: string) {
  if (!text) return;
  const last = nodes.at(-1);
  if (last?.type === 'text') {
    last.text += text;
    return;
  }
  nodes.push({ type: 'text', text });
}

function strongMarkerAt(source: string, cursor: number): string | null {
  if (source.startsWith('**', cursor)) return '**';
  if (source.startsWith('__', cursor)) return '__';
  return null;
}

function emphasisMarkerAt(source: string, cursor: number): string | null {
  if (source.startsWith('*', cursor)) return '*';
  if (source.startsWith('_', cursor)) return '_';
  return null;
}

const wordCharPattern = /[\p{L}\p{N}_]/u;
const htmlTagPattern = /<\/?([A-Za-z][A-Za-z0-9-]*)(?:\s[^<>]*)?\/?>/y;
const DROPPED_HTML_TAGS: ReadonlySet<string> = new Set(['br', 'p', 'div', 'span', 'details', 'summary', 'sub', 'sup', 'kbd', 'picture', 'source', 'center', 'b', 'i', 'em', 'strong', 'hr']);
const IMAGE_PLACEHOLDER = '(image)';

function isWordCharAt(source: string, index: number): boolean {
  const char = source[index];
  return char !== undefined && wordCharPattern.test(char);
}

function isUnderscoreRunOpenerAt(source: string, cursor: number): boolean {
  return !isWordCharAt(source, cursor - 1);
}

function underscoreCloserFinder(source: string, marker: string) {
  return firstIndexFinder(source, marker, (index) => !isWordCharAt(source, index + marker.length));
}

function htmlTagAt(source: string, cursor: number): { name: string; end: number } | null {
  if (source[cursor] !== '<') return null;
  htmlTagPattern.lastIndex = cursor;
  const match = htmlTagPattern.exec(source);
  const name = match?.[1]?.toLowerCase();
  if (!match || !name) return null;
  if (name !== 'img' && !DROPPED_HTML_TAGS.has(name)) return null;
  return { name, end: cursor + match[0].length };
}

function findClosingMarker(source: string, marker: string, from: number) {
  const index = source.indexOf(marker, from);
  return index > from ? index : -1;
}

function closingMarkerIndex(source: string, marker: string, from: number, underscoreCloserAtOrAfter: (from: number) => number) {
  if (!marker.startsWith('_')) return findClosingMarker(source, marker, from);
  const index = underscoreCloserAtOrAfter(from);
  return index > from ? index : -1;
}

function firstIndexFinder(source: string, needle: string, isMatchAt: (index: number) => boolean = () => true) {
  const firstMatchAt = (from: number) => {
    let index = source.indexOf(needle, from);
    while (index !== -1 && !isMatchAt(index)) index = source.indexOf(needle, index + 1);
    return index;
  };
  let firstKnownIndex = firstMatchAt(0);
  return function firstIndexAtOrAfter(from: number): number {
    if (firstKnownIndex === -1) return -1;
    if (firstKnownIndex >= from) return firstKnownIndex;
    firstKnownIndex = firstMatchAt(from);
    return firstKnownIndex;
  };
}

function linkTargetEnd(source: string, start: number): number {
  let openParenDepth = 1;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (char === '(') openParenDepth++;
    if (char === ')') openParenDepth--;
    if (openParenDepth === 0) return index;
    if (openParenDepth > MAX_LINK_TARGET_PAREN_DEPTH) return -1;
  }
  return -1;
}

function planLinkAt(
  source: string,
  cursor: number,
  closeBracketAtOrAfter: (from: number) => number,
): PlanLinkSpan | null {
  if (source[cursor] !== '[') return null;
  const labelEnd = closeBracketAtOrAfter(cursor + 1);
  if (labelEnd <= cursor + 1) return null;
  if (source[labelEnd + 1] !== '(') return null;
  const targetEnd = linkTargetEnd(source, labelEnd + 2);
  if (targetEnd === -1) return null;
  return {
    label: source.slice(cursor + 1, labelEnd),
    target: source.slice(labelEnd + 2, targetEnd),
    end: targetEnd + 1,
  };
}

function parsePlanInline(source: string): PlanInline[] {
  return parseInlineSpan(source, false);
}

function parseInlineSpan(source: string, isInsideLink: boolean): PlanInline[] {
  const nodes: PlanInline[] = [];
  const closeBracketAtOrAfter = firstIndexFinder(source, ']');
  const strongUnderscoreCloserAtOrAfter = underscoreCloserFinder(source, '__');
  const emphasisUnderscoreCloserAtOrAfter = underscoreCloserFinder(source, '_');
  const bareUrlByStart = new Map(isInsideLink ? [] : findUrls(source).map((found) => [found.start, found]));
  let cursor = 0;
  while (cursor < source.length) {
    const link = planLinkAt(source, cursor, closeBracketAtOrAfter);
    if (link) {
      const href = normalizedHttpUrl(link.target.trim());
      if (href) nodes.push({ type: 'link', href, children: parseInlineSpan(link.label, true) });
      if (!href) appendText(nodes, link.label);
      cursor = link.end;
      continue;
    }

    const bareUrl = bareUrlByStart.get(cursor);
    const bareHref = bareUrl ? normalizedHttpUrl(bareUrl.url) : null;
    if (bareUrl && bareHref) {
      nodes.push({ type: 'link', href: bareHref, children: [{ type: 'text', text: bareUrl.url }] });
      cursor = bareUrl.end;
      continue;
    }

    const htmlTag = htmlTagAt(source, cursor);
    if (htmlTag) {
      if (htmlTag.name === 'img') appendText(nodes, IMAGE_PLACEHOLDER);
      cursor = htmlTag.end;
      continue;
    }

    if (source.startsWith('`', cursor)) {
      const closing = findClosingMarker(source, '`', cursor + 1);
      if (closing !== -1) {
        nodes.push({ type: 'code', text: source.slice(cursor + 1, closing) });
        cursor = closing + 1;
        continue;
      }
    }

    const strongMarker = strongMarkerAt(source, cursor);
    if (strongMarker === '__' && !isUnderscoreRunOpenerAt(source, cursor)) {
      appendText(nodes, '__');
      cursor += 2;
      continue;
    }
    if (strongMarker) {
      const closing = closingMarkerIndex(source, strongMarker, cursor + strongMarker.length, strongUnderscoreCloserAtOrAfter);
      if (closing !== -1) {
        nodes.push({
          type: 'strong',
          children: parseInlineSpan(source.slice(cursor + strongMarker.length, closing), isInsideLink),
        });
        cursor = closing + strongMarker.length;
        continue;
      }
    }

    const emphasisMarker = emphasisMarkerAt(source, cursor);
    if (emphasisMarker === '_' && !isUnderscoreRunOpenerAt(source, cursor)) {
      appendText(nodes, '_');
      cursor++;
      continue;
    }
    if (emphasisMarker) {
      const closing = closingMarkerIndex(source, emphasisMarker, cursor + 1, emphasisUnderscoreCloserAtOrAfter);
      if (closing !== -1) {
        nodes.push({ type: 'emphasis', children: parseInlineSpan(source.slice(cursor + 1, closing), isInsideLink) });
        cursor = closing + 1;
        continue;
      }
    }

    appendText(nodes, source[cursor]);
    cursor++;
  }
  return nodes;
}

function planInlineText(nodes: readonly PlanInline[]): string {
  return nodes.map((node) => {
    if (node.type === 'text' || node.type === 'code') return node.text;
    return planInlineText(node.children);
  }).join('');
}

const HEADING_ID_PREFIX = 'plan-h-';

function slugFor(text: string, context: ParseContext) {
  const base = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
  const count = (context.slugCounts.get(base) ?? 0) + 1;
  context.slugCounts.set(base, count);
  const uniqueBase = count === 1 ? base : `${base}-${count}`;
  return `${HEADING_ID_PREFIX}${uniqueBase}`;
}

function isTableDivider(line: string | undefined): boolean {
  if (typeof line !== 'string' || !line.includes('|')) return false;
  const cells = splitTableRow(line);
  if (cells.length < 2) return false;
  return cells.every((cell) => tableDividerCellPattern.test(cell));
}

function splitTableRow(line: string) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

function listLine(line: string): ListLine | null {
  const match = listPattern.exec(line);
  if (!match) return null;
  return {
    indent: match[1].replace(/\t/g, '    ').length,
    ordered: !!match[3],
    content: match[4],
  };
}

function parseList(lines: readonly string[], start: number, context: ParseContext, depth: number) {
  const first = listLine(lines[start]);
  if (!first) return null;
  const items: PlanListItem[] = [];
  const ordered = first.ordered;
  const baseIndent = first.indent;
  let index = start;

  while (index < lines.length) {
    const current = listLine(lines[index]);
    if (!current || current.indent < baseIndent) break;
    if (current.indent > baseIndent) {
      if (depth >= MAX_BLOCK_NESTING_DEPTH) break;
      const nested = parseList(lines, index, context, depth + 1);
      if (!nested || items.length === 0) break;
      items.at(-1)?.children.push(nested.block);
      index = nested.next;
      continue;
    }
    if (current.ordered !== ordered) break;
    items.push({ children: [{ type: 'paragraph', children: parsePlanInline(current.content) }] });
    index++;
  }

  return { block: { type: 'list', ordered, items } satisfies PlanBlock, next: index };
}

function isBlockStart(lines: readonly string[], index: number) {
  const line = lines[index] ?? '';
  if (line.trim() === '') return true;
  if (headingLine(line) || fencePattern.test(line) || rulePattern.test(line)) return true;
  if (listLine(line) || /^ {0,3}>/.test(line)) return true;
  return index + 1 < lines.length && line.includes('|') && isTableDivider(lines[index + 1]);
}

function parseBlocks(lines: readonly string[], context: ParseContext, depth: number): PlanBlock[] {
  const blocks: PlanBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      index++;
      continue;
    }

    const fence = fencePattern.exec(line);
    if (fence) {
      const body: string[] = [];
      const fenceMarker = fence[1][0];
      const fenceLength = fence[1].length;
      index++;
      while (index < lines.length) {
        const closingFence = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[index]);
        if (closingFence && closingFence[1][0] === fenceMarker && closingFence[1].length >= fenceLength) break;
        body.push(lines[index]);
        index++;
      }
      if (index < lines.length) index++;
      blocks.push({ type: 'code', language: fenceLanguage(fence[2]), text: body.join('\n') });
      continue;
    }

    const heading = headingLine(line);
    if (heading) {
      const children = parsePlanInline(heading.text);
      blocks.push({ type: 'heading', level: heading.level, id: slugFor(planInlineText(children), context), children });
      index++;
      continue;
    }

    if (rulePattern.test(line)) {
      blocks.push({ type: 'rule' });
      index++;
      continue;
    }

    if (index + 1 < lines.length && line.includes('|') && isTableDivider(lines[index + 1])) {
      const header = splitTableRow(line).map(parsePlanInline);
      const rows: PlanInline[][][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') {
        rows.push(splitTableRow(lines[index]).map(parsePlanInline));
        index++;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    const parsedList = parseList(lines, index, context, depth);
    if (parsedList) {
      blocks.push(parsedList.block);
      index = parsedList.next;
      continue;
    }

    if (depth < MAX_BLOCK_NESTING_DEPTH && /^ {0,3}>/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^ {0,3}> ?/, ''));
        index++;
      }
      blocks.push({ type: 'blockquote', blocks: parseBlocks(quoteLines, context, depth + 1) });
      continue;
    }

    const paragraphLines = [line.trim()];
    index++;
    while (index < lines.length && !isBlockStart(lines, index)) {
      paragraphLines.push(lines[index].trim());
      index++;
    }
    blocks.push({ type: 'paragraph', children: parsePlanInline(paragraphLines.join(' ')) });
  }
  return blocks;
}

export function parsePlanMarkdown(markdown: string): PlanBlock[] {
  return parseBlocks(markdown.replace(/\r\n?/g, '\n').split('\n'), { slugCounts: new Map() }, 0);
}

export interface PlanSection {
  heading: string | null;
  id: string | null;
  level: number;
  blocks: PlanBlock[];
}

export function splitPlanSections(blocks: readonly PlanBlock[]): PlanSection[] {
  const sections: PlanSection[] = [];
  let current: PlanSection = { heading: null, id: null, level: 0, blocks: [] };
  const closeCurrent = () => {
    if (current.heading === null && current.blocks.length === 0) return;
    sections.push(current);
  };
  for (const block of blocks) {
    if (block.type !== 'heading') {
      current.blocks.push(block);
      continue;
    }
    closeCurrent();
    current = {
      heading: planInlineText(block.children),
      id: block.id,
      level: block.level,
      blocks: [block],
    };
  }
  closeCurrent();
  return sections;
}
