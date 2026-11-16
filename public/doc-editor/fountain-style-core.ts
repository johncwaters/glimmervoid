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

export function isHiddenOnPage(element: ScreenplayElement): boolean {
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
    return { element, pageText: pageTextOf(element, text) };
  });
}

export function screenplayElementsOf(source: string): ScreenplayElement[] {
  return screenplayLinesOf(source).map((line) => line.element);
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
