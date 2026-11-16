export type ScreenplayElement = 'title' | 'scene' | 'action' | 'character' | 'parenthetical' | 'dialogue' | 'lyric' | 'transition' | 'centered' | 'page-break' | 'section' | 'synopsis' | 'note' | 'boneyard' | 'blank';

const FOUNTAIN_EXTENSION = '.fountain';

const TITLE_KEY_LINE = /^[A-Za-z][A-Za-z ]*:/;
const SCENE_HEADING = /^(?:INT|EXT|EST|INT\.?\/EXT|I\/E)[. ]/i;
const FORCED_SCENE_HEADING = /^\.[\p{L}\p{N}]/u;
const PAGE_BREAK = /^={3,}\s*$/;
const CENTERED = /^>.*<$/;
const PARENTHETICAL = /^\(.*\)$/;
const SCENE_NUMBER = /\s*#[\w.-]+#\s*$/;
const TITLE_KEY_PREFIX = /^[A-Za-z][A-Za-z ]*:\s*/;
const HIDDEN_ON_PAGE: ReadonlySet<ScreenplayElement> = new Set(['note', 'boneyard', 'section', 'synopsis']);

export function isFountainPath(docPath: string): boolean {
  return docPath.toLowerCase().endsWith(FOUNTAIN_EXTENSION);
}

function isHiddenOnPage(element: ScreenplayElement): boolean {
  return HIDDEN_ON_PAGE.has(element);
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim() === '';
}

function isUppercaseName(text: string): boolean {
  const name = text.replace(/\s*\^$/, '').replace(/\(.*$/, '').trim();
  return /\p{L}/u.test(name) && name === name.toUpperCase();
}

function titlePageEndOf(lines: readonly string[]): number {
  if (!TITLE_KEY_LINE.test(lines[0] ?? '')) return 0;
  const firstBlank = lines.findIndex(isBlank);
  return firstBlank === -1 ? lines.length : firstBlank;
}

function forcedElementOf(trimmed: string): ScreenplayElement | null {
  if (PAGE_BREAK.test(trimmed)) return 'page-break';
  if (trimmed.startsWith('#')) return 'section';
  if (trimmed.startsWith('=')) return 'synopsis';
  if (trimmed.startsWith('~')) return 'lyric';
  if (trimmed.startsWith('!')) return 'action';
  if (FORCED_SCENE_HEADING.test(trimmed)) return 'scene';
  if (CENTERED.test(trimmed)) return 'centered';
  if (trimmed.startsWith('>')) return 'transition';
  return null;
}

function unforcedElementOf(trimmed: string, isAfterBlank: boolean, isBeforeBlank: boolean): ScreenplayElement {
  if (!isAfterBlank) return 'action';
  if (SCENE_HEADING.test(trimmed)) return 'scene';
  if (isBeforeBlank && trimmed.endsWith('TO:') && trimmed === trimmed.toUpperCase()) return 'transition';
  if (!isBeforeBlank && isUppercaseName(trimmed)) return 'character';
  return 'action';
}

type HiddenSpan = 'boneyard' | 'note';

interface VisibleLine {
  text: string;
  hiddenAs: HiddenSpan | null;
}

const HIDDEN_SPAN_CLOSER: Record<HiddenSpan, string> = { boneyard: '*/', note: ']]' };

function nextHiddenOpening(line: string, fromIndex: number): { index: number; span: HiddenSpan } | null {
  const boneyardIndex = line.indexOf('/*', fromIndex);
  const noteIndex = line.indexOf('[[', fromIndex);
  if (boneyardIndex === -1 && noteIndex === -1) return null;
  if (noteIndex === -1 || (boneyardIndex !== -1 && boneyardIndex < noteIndex)) return { index: boneyardIndex, span: 'boneyard' };
  return { index: noteIndex, span: 'note' };
}

function visibleLinesOf(lines: readonly string[]): VisibleLine[] {
  let openSpan: HiddenSpan | null = null;
  return lines.map((line) => {
    if (openSpan === 'note' && line === '') openSpan = null;
    const spanAtLineStart = openSpan;
    let lastOpenedSpan: HiddenSpan | null = null;
    let visibleText = '';
    let index = 0;
    while (index < line.length) {
      if (openSpan) {
        const closeIndex = line.indexOf(HIDDEN_SPAN_CLOSER[openSpan], index);
        if (closeIndex === -1) break;
        index = closeIndex + 2;
        openSpan = null;
        continue;
      }
      const opening = nextHiddenOpening(line, index);
      if (!opening) {
        visibleText += line.slice(index);
        break;
      }
      visibleText += line.slice(index, opening.index);
      openSpan = opening.span;
      lastOpenedSpan = opening.span;
      index = opening.index + 2;
    }
    const isWhollyHidden = line.trim() !== '' && visibleText.trim() === '';
    return { text: visibleText, hiddenAs: isWhollyHidden ? (spanAtLineStart ?? lastOpenedSpan) : null };
  });
}

interface ScreenplayLine {
  element: ScreenplayElement;
  pageText: string;
  sceneNumber: string | null;
}

function elementsOfVisibleLines(lines: readonly VisibleLine[], titleEnd: number): ScreenplayElement[] {
  const elements: ScreenplayElement[] = lines.slice(0, titleEnd).map(() => 'title');
  let isInDialogue = false;
  for (let lineIndex = titleEnd; lineIndex < lines.length; lineIndex += 1) {
    const { text, hiddenAs } = lines[lineIndex];
    if (hiddenAs) {
      elements.push(hiddenAs);
      continue;
    }
    const trimmed = text.trim();
    if (trimmed === '') {
      const keepsDialogue: boolean = isInDialogue && text.length >= 2;
      elements.push(keepsDialogue ? 'dialogue' : 'blank');
      isInDialogue = keepsDialogue;
      continue;
    }
    if (isInDialogue) {
      elements.push(PARENTHETICAL.test(trimmed) ? 'parenthetical' : 'dialogue');
      continue;
    }
    const isBeforeBlank = isBlank(lines[lineIndex + 1]?.text);
    if (trimmed.startsWith('@')) {
      elements.push('character');
      isInDialogue = !isBeforeBlank;
      continue;
    }
    const isAfterBlank = lineIndex === titleEnd || isBlank(lines[lineIndex - 1]?.text);
    const element = forcedElementOf(trimmed) ?? unforcedElementOf(trimmed, isAfterBlank, isBeforeBlank);
    elements.push(element);
    isInDialogue = element === 'character';
  }
  return elements;
}

export function screenplayLinesOf(source: string): ScreenplayLine[] {
  const lines = source.split('\n');
  const visibleLines = visibleLinesOf(lines);
  const elements = elementsOfVisibleLines(visibleLines, titlePageEndOf(lines));
  return visibleLines.map(({ text }, lineIndex) => {
    const element = elements[lineIndex] ?? 'action';
    return { element, pageText: pageTextOf(element, text), sceneNumber: element === 'scene' ? sceneNumberOf(text) : null };
  });
}

export function screenplayElementsOf(source: string): ScreenplayElement[] {
  return screenplayLinesOf(source).map((line) => line.element);
}

function sceneNumberOf(visibleText: string): string | null {
  const numberMatch = SCENE_NUMBER.exec(visibleText.trim());
  return numberMatch ? numberMatch[0].trim().slice(1, -1) : null;
}

const FORCING_PREFIX_BY_ELEMENT: Partial<Record<ScreenplayElement, RegExp>> = {
  action: /^!/,
  character: /^@/,
  lyric: /^~\s?/,
  transition: /^>\s*/,
};

function pageTextOf(element: ScreenplayElement, visibleText: string): string {
  const visible = visibleText.trim();
  if (element === 'title') return visible.replace(TITLE_KEY_PREFIX, '');
  if (element === 'centered') return visible.slice(1, -1).trim();
  if (element === 'scene') return visible.replace(/^\./, '').replace(SCENE_NUMBER, '');
  if (element === 'character') return visible.replace(/^@/, '').replace(/\s*\^$/, '');
  const forcingPrefix = FORCING_PREFIX_BY_ELEMENT[element];
  return forcingPrefix ? visible.replace(forcingPrefix, '') : visible;
}

interface EmphasisSegment {
  text: string;
  isBold: boolean;
  isItalic: boolean;
  isUnderlined: boolean;
}

type EmphasisFlags = Omit<EmphasisSegment, 'text'>;

const ESCAPED_ASTERISK = String.fromCharCode(0xe000);
const ESCAPED_UNDERSCORE = String.fromCharCode(0xe001);
const EMPHASIS_SPANS: readonly { pattern: RegExp; adds: Partial<EmphasisFlags> }[] = [
  { pattern: /\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/, adds: { isBold: true, isItalic: true } },
  { pattern: /\*\*(?=\S)(.+?)(?<=\S)\*\*/, adds: { isBold: true } },
  { pattern: /\*(?=\S)(.+?)(?<=\S)\*/, adds: { isItalic: true } },
  { pattern: /_(?=\S)(.+?)(?<=\S)_/, adds: { isUnderlined: true } },
];

function unescaped(text: string): string {
  return text.replaceAll(ESCAPED_ASTERISK, '*').replaceAll(ESCAPED_UNDERSCORE, '_');
}

function earliestEmphasisIn(text: string) {
  let earliest: { match: RegExpExecArray; adds: Partial<EmphasisFlags> } | null = null;
  for (const { pattern, adds } of EMPHASIS_SPANS) {
    const match = pattern.exec(text);
    if (match && (!earliest || match.index < earliest.match.index)) earliest = { match, adds };
  }
  return earliest;
}

function segmentsWith(text: string, flags: EmphasisFlags): EmphasisSegment[] {
  const emphasis = earliestEmphasisIn(text);
  if (!emphasis) return text ? [{ text: unescaped(text), ...flags }] : [];
  const { match, adds } = emphasis;
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  return [
    ...(before ? [{ text: unescaped(before), ...flags }] : []),
    ...segmentsWith(match[1] ?? '', { ...flags, ...adds }),
    ...segmentsWith(after, flags),
  ];
}

export function emphasisSegmentsOf(text: string): EmphasisSegment[] {
  const escaped = text.replaceAll('\\*', ESCAPED_ASTERISK).replaceAll('\\_', ESCAPED_UNDERSCORE);
  return segmentsWith(escaped, { isBold: false, isItalic: false, isUnderlined: false });
}

const LINES_PER_PAGE = 55;
const MIN_LINES_EACH_SIDE_OF_SPLIT = 2;
const DEFAULT_WRAP_WIDTH = 60;
const WRAP_WIDTH_BY_ELEMENT: Partial<Record<PageRowElement, number>> = { character: 38, dialogue: 35, lyric: 35, parenthetical: 25 };
const SENTENCE_END = /[.?!]["')\]]*$/;
const CONTINUED_SUFFIX = /\s*\(CONT'D\)\s*$/i;

type PageRowElement = ScreenplayElement | 'more';

interface PageRow {
  element: PageRowElement;
  text: string;
  sourceLineIndex: number;
  sceneNumber: string | null;
}

interface ScreenplayPage {
  number: number;
  rows: PageRow[];
}

interface WrappedLine extends PageRow {
  endsSentence: boolean;
}

interface PageBlock {
  lines: WrappedLine[];
  blanksBefore: number;
  kind: 'scene' | 'speech' | 'action' | 'page-break' | 'other';
}

function wrappedTextOf(text: string, width: number): string[] {
  const wrapped: string[] = [];
  let currentLine = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (candidate.length <= width || !currentLine) {
      currentLine = candidate;
      continue;
    }
    wrapped.push(currentLine);
    currentLine = word;
  }
  wrapped.push(currentLine);
  return wrapped;
}

function wrappedLinesOf(line: ScreenplayLine, sourceLineIndex: number): WrappedLine[] {
  const pieces = wrappedTextOf(line.pageText, WRAP_WIDTH_BY_ELEMENT[line.element] ?? DEFAULT_WRAP_WIDTH);
  return pieces.map((piece, pieceIndex) => ({
    element: line.element,
    text: piece,
    sourceLineIndex,
    sceneNumber: pieceIndex === 0 ? line.sceneNumber : null,
    endsSentence: SENTENCE_END.test(piece),
  }));
}

function blockKindOf(firstElement: ScreenplayElement): PageBlock['kind'] {
  if (firstElement === 'scene') return 'scene';
  if (firstElement === 'character') return 'speech';
  if (firstElement === 'action') return 'action';
  if (firstElement === 'page-break') return 'page-break';
  return 'other';
}

function pageBlocksOf(lines: readonly ScreenplayLine[]): { titleRows: PageRow[]; blocks: PageBlock[] } {
  const titleRows: PageRow[] = [];
  const blocks: PageBlock[] = [];
  let blanksBefore = 0;
  let isBlankAfterHiddenLineDropped = false;
  let openBlock: PageBlock | null = null;
  lines.forEach((line, sourceLineIndex) => {
    if (isHiddenOnPage(line.element)) {
      isBlankAfterHiddenLineDropped = blanksBefore > 0;
      return;
    }
    if (line.element === 'title') {
      titleRows.push({ element: 'title', text: line.pageText, sourceLineIndex, sceneNumber: null });
      return;
    }
    if (line.element === 'blank') {
      openBlock = null;
      blanksBefore += isBlankAfterHiddenLineDropped ? 0 : 1;
      isBlankAfterHiddenLineDropped = false;
      return;
    }
    isBlankAfterHiddenLineDropped = false;
    if (line.element === 'page-break') {
      openBlock = null;
      blocks.push({ lines: [], blanksBefore: 0, kind: 'page-break' });
      blanksBefore = 0;
      return;
    }
    if (!openBlock) {
      openBlock = { lines: [], blanksBefore, kind: blockKindOf(line.element) };
      blocks.push(openBlock);
      blanksBefore = 0;
    }
    openBlock.lines.push(...wrappedLinesOf(line, sourceLineIndex));
  });
  return { titleRows, blocks };
}

function rowOf({ endsSentence: _endsSentence, ...row }: WrappedLine): PageRow {
  return row;
}

function splitPointOf(block: PageBlock, linesAvailable: number): number | null {
  const isSpeech = block.kind === 'speech';
  const reservedForMore = isSpeech ? 1 : 0;
  const firstAllowed = isSpeech ? 1 + MIN_LINES_EACH_SIDE_OF_SPLIT : MIN_LINES_EACH_SIDE_OF_SPLIT;
  const lastAllowed = Math.min(linesAvailable - reservedForMore, block.lines.length - MIN_LINES_EACH_SIDE_OF_SPLIT);
  for (let keptLines = lastAllowed; keptLines >= firstAllowed; keptLines -= 1) {
    if (block.lines[keptLines - 1]?.endsSentence) return keptLines;
  }
  return null;
}

function continuedCueOf(block: PageBlock, firstRemainingLine: WrappedLine): WrappedLine {
  const cueName = (block.lines[0]?.text ?? '').replace(CONTINUED_SUFFIX, '');
  return { element: 'character', text: `${cueName} (CONT'D)`, sourceLineIndex: firstRemainingLine.sourceLineIndex, sceneNumber: null, endsSentence: false };
}

function isSplittable(block: PageBlock): boolean {
  return block.kind === 'speech' || block.kind === 'action';
}

function canStartIn(block: PageBlock, linesAvailable: number): boolean {
  if (block.lines.length <= linesAvailable) return true;
  return isSplittable(block) && splitPointOf(block, linesAvailable) !== null;
}

export function screenplayPagesOf(lines: readonly ScreenplayLine[]): ScreenplayPage[] {
  const { titleRows, blocks } = pageBlocksOf(lines);
  const pages: ScreenplayPage[] = titleRows.length > 0 ? [{ number: 0, rows: titleRows }] : [];
  let page: ScreenplayPage = { number: 1, rows: [] };
  let linesUsed = 0;
  pages.push(page);
  const startNextPage = () => {
    page = { number: page.number + 1, rows: [] };
    linesUsed = 0;
    pages.push(page);
  };
  const placeLines = (blanksBefore: number, rows: readonly PageRow[]) => {
    const blankSourceIndex = rows[0]?.sourceLineIndex ?? 0;
    if (linesUsed > 0) {
      for (let blankIndex = 0; blankIndex < blanksBefore; blankIndex += 1) page.rows.push({ element: 'blank', text: '', sourceLineIndex: blankSourceIndex, sceneNumber: null });
      linesUsed += blanksBefore;
    }
    linesUsed += rows.length;
    for (const row of rows) {
      const previousRow = page.rows.at(-1);
      const continuesPreviousRow = previousRow !== undefined && previousRow.sourceLineIndex === row.sourceLineIndex && previousRow.element === row.element && row.element !== 'blank';
      if (continuesPreviousRow) {
        previousRow.text = `${previousRow.text} ${row.text}`;
        continue;
      }
      page.rows.push({ ...row });
    }
  };
  const pendingBlocks = [...blocks];
  for (let blockIndex = 0; blockIndex < pendingBlocks.length; blockIndex += 1) {
    const block = pendingBlocks[blockIndex];
    if (!block) continue;
    if (block.kind === 'page-break') {
      if (linesUsed > 0) startNextPage();
      continue;
    }
    const gapLines = linesUsed > 0 ? block.blanksBefore : 0;
    const linesAvailable = LINES_PER_PAGE - linesUsed - gapLines;
    const nextBlock = pendingBlocks[blockIndex + 1];
    const isHeadingStrandedFromNext = block.kind === 'scene' && nextBlock !== undefined && nextBlock.kind !== 'page-break' && !canStartIn(nextBlock, linesAvailable - block.lines.length - nextBlock.blanksBefore);
    const fitsWhole = block.lines.length <= linesAvailable && !isHeadingStrandedFromNext;
    if (fitsWhole) {
      placeLines(block.blanksBefore, block.lines.map(rowOf));
      continue;
    }
    const splitPoint = isSplittable(block) ? splitPointOf(block, linesAvailable) : null;
    if (splitPoint === null && linesUsed > 0) {
      startNextPage();
      pendingBlocks.splice(blockIndex + 1, 0, { ...block, blanksBefore: 0 });
      continue;
    }
    const forcedSplitPoint = splitPoint ?? LINES_PER_PAGE;
    const keptLines = block.lines.slice(0, forcedSplitPoint);
    const movedLines = block.lines.slice(forcedSplitPoint);
    const isSpeech = block.kind === 'speech' && splitPoint !== null;
    const moreRow: PageRow[] = isSpeech ? [{ element: 'more', text: '(MORE)', sourceLineIndex: keptLines.at(-1)?.sourceLineIndex ?? 0, sceneNumber: null }] : [];
    placeLines(block.blanksBefore, [...keptLines.map(rowOf), ...moreRow]);
    const firstMovedLine = movedLines[0];
    if (!firstMovedLine) continue;
    startNextPage();
    const continuedLines = isSpeech ? [continuedCueOf(block, firstMovedLine), ...movedLines] : movedLines;
    pendingBlocks.splice(blockIndex + 1, 0, { lines: continuedLines, blanksBefore: 0, kind: block.kind });
  }
  return pages;
}
