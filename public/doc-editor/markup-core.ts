const MARGIN_CODES = ['wc', 'awk', 'frag', 'tense', 'unclear', 'para', 'good', 'must', 'end'] as const;
type MarginCode = (typeof MARGIN_CODES)[number];

type MarkKind = 'deletion' | 'insertion' | 'substitution' | 'highlight' | 'comment';
export type MarkDecision = 'accept' | 'reject';
export type OperatorMarkAction = 'strike' | 'insert' | 'replace' | 'note';

interface MarginNote {
  code: MarginCode | null;
  body: string;
}

export interface TextSegment {
  kind: 'text';
  start: number;
  text: string;
}

export interface MarkSegment {
  kind: 'mark';
  markKind: MarkKind;
  start: number;
  end: number;
  oldText: string;
  newText: string;
  note: MarginNote | null;
}

type MarkupSegment = TextSegment | MarkSegment;

export interface SourceSelection {
  start: number;
  end: number;
}

const NOTE_OPENER = '{>>';
const NOTE_CLOSER = '<<}';
const SUBSTITUTION_SEPARATOR = '~>';
const MARK_OPENERS = [
  { opener: '{--', closer: '--}', markKind: 'deletion' },
  { opener: '{++', closer: '++}', markKind: 'insertion' },
  { opener: '{~~', closer: '~~}', markKind: 'substitution' },
  { opener: '{==', closer: '==}', markKind: 'highlight' },
  { opener: NOTE_OPENER, closer: NOTE_CLOSER, markKind: 'comment' },
] as const;
const MARKUP_DELIMITERS = [...MARK_OPENERS.flatMap(({ opener, closer }) => [opener, closer]), SUBSTITUTION_SEPARATOR];
const MARGIN_CODE_PATTERN = new RegExp(`^(${MARGIN_CODES.join('|')}):\\s*`, 'i');

function isMarginCode(candidate: string): candidate is MarginCode {
  return (MARGIN_CODES as readonly string[]).includes(candidate);
}

function parseMarginNote(rawNote: string | undefined): MarginNote | null {
  if (rawNote === undefined || rawNote.trim() === '') return null;
  const codeMatch = MARGIN_CODE_PATTERN.exec(rawNote);
  const code = codeMatch?.[1]?.toLowerCase() ?? '';
  if (!codeMatch || !isMarginCode(code)) return { code: null, body: rawNote.trim() };
  return { code, body: rawNote.slice(codeMatch[0].length).trim() };
}

function createTokenFinder(source: string) {
  const lastSearchByToken = new Map<string, { searchedFrom: number; foundAt: number }>();
  return (token: string, from: number): number => {
    const lastSearch = lastSearchByToken.get(token);
    const isLastSearchValid = lastSearch !== undefined && lastSearch.searchedFrom <= from && (lastSearch.foundAt === -1 || lastSearch.foundAt >= from);
    if (isLastSearchValid) return lastSearch.foundAt;
    const foundAt = source.indexOf(token, from);
    lastSearchByToken.set(token, { searchedFrom: from, foundAt });
    return foundAt;
  };
}

type TokenFinder = ReturnType<typeof createTokenFinder>;

function readTrailingNote(source: string, findToken: TokenFinder, markEnd: number): { rawNote: string | undefined; end: number } {
  if (!source.startsWith(NOTE_OPENER, markEnd)) return { rawNote: undefined, end: markEnd };
  const noteCloseAt = findToken(NOTE_CLOSER, markEnd + NOTE_OPENER.length);
  if (noteCloseAt === -1) return { rawNote: undefined, end: markEnd };
  return { rawNote: source.slice(markEnd + NOTE_OPENER.length, noteCloseAt), end: noteCloseAt + NOTE_CLOSER.length };
}

function readSubstitution(source: string, findToken: TokenFinder, bodyStart: number): { oldText: string; newText: string; closeAt: number } | null {
  const separatorAt = findToken(SUBSTITUTION_SEPARATOR, bodyStart);
  if (separatorAt === -1) return null;
  const closeAt = findToken('~~}', separatorAt + SUBSTITUTION_SEPARATOR.length);
  if (closeAt === -1) return null;
  return { oldText: source.slice(bodyStart, separatorAt), newText: source.slice(separatorAt + SUBSTITUTION_SEPARATOR.length, closeAt), closeAt };
}

function readMarkAt(source: string, findToken: TokenFinder, start: number): MarkSegment | null {
  const markOpener = MARK_OPENERS.find(({ opener }) => source.startsWith(opener, start));
  if (!markOpener) return null;
  const bodyStart = start + markOpener.opener.length;
  if (markOpener.markKind === 'substitution') {
    const substitution = readSubstitution(source, findToken, bodyStart);
    if (!substitution) return null;
    const trailingNote = readTrailingNote(source, findToken, substitution.closeAt + markOpener.closer.length);
    return { kind: 'mark', markKind: 'substitution', start, end: trailingNote.end, oldText: substitution.oldText, newText: substitution.newText, note: parseMarginNote(trailingNote.rawNote) };
  }
  const closeAt = findToken(markOpener.closer, bodyStart);
  if (closeAt === -1) return null;
  const body = source.slice(bodyStart, closeAt);
  const bodyEnd = closeAt + markOpener.closer.length;
  if (markOpener.markKind === 'comment') return { kind: 'mark', markKind: 'comment', start, end: bodyEnd, oldText: '', newText: '', note: parseMarginNote(body) };
  const trailingNote = readTrailingNote(source, findToken, bodyEnd);
  const isInsertion = markOpener.markKind === 'insertion';
  return { kind: 'mark', markKind: markOpener.markKind, start, end: trailingNote.end, oldText: isInsertion ? '' : body, newText: isInsertion ? body : '', note: parseMarginNote(trailingNote.rawNote) };
}

export function parseCriticMarkup(source: string): MarkupSegment[] {
  const segments: MarkupSegment[] = [];
  const findToken = createTokenFinder(source);
  let copiedUpTo = 0;
  let braceAt = source.indexOf('{');
  while (braceAt !== -1) {
    const mark = readMarkAt(source, findToken, braceAt);
    if (!mark) {
      braceAt = source.indexOf('{', braceAt + 1);
      continue;
    }
    if (mark.start > copiedUpTo) segments.push({ kind: 'text', start: copiedUpTo, text: source.slice(copiedUpTo, mark.start) });
    segments.push(mark);
    copiedUpTo = mark.end;
    braceAt = source.indexOf('{', mark.end);
  }
  if (copiedUpTo < source.length) segments.push({ kind: 'text', start: copiedUpTo, text: source.slice(copiedUpTo) });
  return segments;
}

export function isEndNote(mark: MarkSegment): boolean {
  return mark.markKind === 'comment' && mark.note?.code === 'end';
}

function resolvedTextOf(mark: MarkSegment, decision: MarkDecision): string {
  const isAccepted = decision === 'accept';
  switch (mark.markKind) {
    case 'deletion': return isAccepted ? '' : mark.oldText;
    case 'insertion': return isAccepted ? mark.newText : '';
    case 'substitution': return isAccepted ? mark.newText : mark.oldText;
    case 'highlight': return mark.oldText;
    case 'comment': return '';
  }
}

export function resolveMark(source: string, mark: MarkSegment, decision: MarkDecision): string {
  return source.slice(0, mark.start) + resolvedTextOf(mark, decision) + source.slice(mark.end);
}

function markupFor(action: OperatorMarkAction, selectedText: string, operatorText: string): string {
  switch (action) {
    case 'strike': return `{--${selectedText}--}`;
    case 'insert': return `{++${operatorText}++}`;
    case 'replace': return `{~~${selectedText}~>${operatorText}~~}`;
    case 'note': return `{==${selectedText}==}{>>${operatorText.trim()}<<}`;
  }
}

export function holdsMarkupDelimiter(text: string): boolean {
  return MARKUP_DELIMITERS.some((delimiter) => text.includes(delimiter));
}

export function canApplyOperatorMark(source: string, action: OperatorMarkAction, selection: SourceSelection | null, operatorText: string): boolean {
  if (!selection) return false;
  if (holdsMarkupDelimiter(source.slice(selection.start, selection.end)) || holdsMarkupDelimiter(operatorText)) return false;
  const hasSelectedText = selection.end > selection.start;
  const hasOperatorText = operatorText.trim().length > 0;
  switch (action) {
    case 'strike': return hasSelectedText;
    case 'insert': return !hasSelectedText && hasOperatorText;
    case 'replace': return hasSelectedText && hasOperatorText;
    case 'note': return hasSelectedText && hasOperatorText;
  }
}

export function applyOperatorMark(source: string, action: OperatorMarkAction, selection: SourceSelection, operatorText: string): string | null {
  const selectedText = source.slice(selection.start, selection.end);
  const wouldAbsorbNextNote = action !== 'note' && source.startsWith(NOTE_OPENER, selection.end);
  const noteTerminator = wouldAbsorbNextNote ? `${NOTE_OPENER}${NOTE_CLOSER}` : '';
  const insertedMarkup = markupFor(action, selectedText, operatorText) + noteTerminator;
  const markedSource = source.slice(0, selection.start) + insertedMarkup + source.slice(selection.end);
  const operatorMarkEnd = selection.start + insertedMarkup.length;
  const isOperatorMarkWhole = parseCriticMarkup(markedSource).some((segment) => segment.kind === 'mark' && segment.start === selection.start && segment.end === operatorMarkEnd);
  return isOperatorMarkWhole ? markedSource : null;
}

export function agentPromptFor(docPath: string, openMarkCount: number): string {
  return [
    `I marked up ${docPath} in red pen: ${openMarkCount} open CriticMarkup marks.`,
    'Read the file. For each {--cut--}, {++add++} and {~~old~>new~~} apply it unless you disagree, {==text==}{>>note<<} is my note on that text.',
    'A note may start with a margin code: wc word choice, awk awkward, frag fragment, tense, unclear, para new paragraph, must required, good keep this, end overall note.',
    'Remove every mark once handled, then tell me which ones you pushed back on and why.',
  ].join('\n');
}
