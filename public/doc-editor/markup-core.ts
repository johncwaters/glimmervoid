const MARGIN_CODES = ['wc', 'awk', 'frag', 'tense', 'unclear', 'para', 'good', 'must', 'end'] as const;
type MarginCode = (typeof MARGIN_CODES)[number];

type MarkKind = 'deletion' | 'insertion' | 'substitution' | 'highlight' | 'comment';
export type MarkDecision = 'accept' | 'reject';

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

export function acceptEveryMark(source: string): string {
  return parseCriticMarkup(source).map((segment) => segment.kind === 'text' ? segment.text : resolvedTextOf(segment, 'accept')).join('');
}

function holdsMarkupDelimiter(text: string): boolean {
  return MARKUP_DELIMITERS.some((delimiter) => text.includes(delimiter));
}

export interface SuggestRun {
  markStart: number;
  markEnd: number;
}

export type SuggestEdit =
  | { kind: 'type'; selection: SourceSelection; text: string }
  | { kind: 'delete'; selection: SourceSelection; direction: 'backward' | 'forward' }
  | { kind: 'paragraph'; selection: SourceSelection }
  | { kind: 'note'; selection: SourceSelection; body: string };

export type SuggestRefusal = 'delimiter' | 'swallowed' | 'nested' | 'nothing';

type SuggestOutcome =
  | { kind: 'applied'; source: string; caret: number; run: SuggestRun | null }
  | { kind: 'refused'; reason: SuggestRefusal };

type WrittenMark = { source: string; markEnd: number };

function refused(reason: SuggestRefusal): SuggestOutcome {
  return { kind: 'refused', reason };
}

function marksOf(source: string): MarkSegment[] {
  return parseCriticMarkup(source).filter((segment): segment is MarkSegment => segment.kind === 'mark');
}

function isCollapsed(selection: SourceSelection) {
  return selection.start === selection.end;
}

function markupFor(markKind: 'insertion' | 'deletion' | 'substitution', oldText: string, newText: string) {
  switch (markKind) {
    case 'insertion': return `{++${newText}++}`;
    case 'deletion': return `{--${oldText}--}`;
    case 'substitution': return `{~~${oldText}~>${newText}~~}`;
  }
}

function writeMark(source: string, selection: SourceSelection, markup: string, leadingSeparator = ''): WrittenMark | null {
  const wouldAbsorbNextNote = !markup.endsWith(NOTE_CLOSER) && source.startsWith(NOTE_OPENER, selection.end);
  const written = leadingSeparator + markup + (wouldAbsorbNextNote ? `${NOTE_OPENER}${NOTE_CLOSER}` : '');
  const markedSource = source.slice(0, selection.start) + written + source.slice(selection.end);
  const markStart = selection.start + leadingSeparator.length;
  const markEnd = selection.start + written.length;
  const isWhole = marksOf(markedSource).some((mark) => mark.start === markStart && mark.end === markEnd);
  return isWhole ? { source: markedSource, markEnd } : null;
}

function applied(written: WrittenMark, caret: number, run: SuggestRun | null): SuggestOutcome {
  return { kind: 'applied', source: written.source, caret, run };
}

function activeRunMark(source: string, selection: SourceSelection, run: SuggestRun | null): MarkSegment | null {
  if (!run || !isCollapsed(selection) || selection.start !== run.markEnd) return null;
  const mark = marksOf(source).find((candidate) => candidate.start === run.markStart && candidate.end === run.markEnd);
  if (!mark || mark.note || (mark.markKind !== 'insertion' && mark.markKind !== 'substitution')) return null;
  return mark;
}

function rewriteRunMark(source: string, mark: MarkSegment, newText: string): SuggestOutcome {
  if (newText === '' && mark.markKind === 'insertion') return { kind: 'applied', source: source.slice(0, mark.start) + source.slice(mark.end), caret: mark.start, run: null };
  if (holdsMarkupDelimiter(newText)) return refused('delimiter');
  const markKind = mark.markKind === 'insertion' ? 'insertion' : 'substitution';
  const written = writeMark(source, mark, markupFor(markKind, mark.oldText, newText));
  if (!written) return refused('swallowed');
  return applied(written, written.markEnd, { markStart: mark.start, markEnd: written.markEnd });
}

function typeText(source: string, selection: SourceSelection, text: string, run: SuggestRun | null): SuggestOutcome {
  if (text === '') return refused('nothing');
  const runMark = activeRunMark(source, selection, run);
  if (runMark) return rewriteRunMark(source, runMark, runMark.newText + text);
  const selectedText = source.slice(selection.start, selection.end);
  if (holdsMarkupDelimiter(text) || holdsMarkupDelimiter(selectedText)) return refused('delimiter');
  const markup = isCollapsed(selection) ? markupFor('insertion', '', text) : markupFor('substitution', selectedText, text);
  const written = writeMark(source, selection, markup);
  if (!written) return refused('swallowed');
  return applied(written, written.markEnd, { markStart: selection.start, markEnd: written.markEnd });
}

function isPlainCharAt(source: string, offset: number) {
  if (offset < 0 || offset >= source.length || source[offset] === '\n') return false;
  return parseCriticMarkup(source).some((segment) => segment.kind === 'text' && segment.start <= offset && offset < segment.start + segment.text.length);
}

function strike(source: string, range: SourceSelection, direction: 'backward' | 'forward'): SuggestOutcome {
  const struckText = source.slice(range.start, range.end);
  if (holdsMarkupDelimiter(struckText)) return refused('delimiter');
  const plainCuts = marksOf(source).filter((mark) => mark.markKind === 'deletion' && !mark.note);
  const cutBefore = plainCuts.find((mark) => mark.end === range.start);
  const cutAfter = plainCuts.find((mark) => mark.start === range.end);
  const mergedRange = { start: cutBefore?.start ?? range.start, end: cutAfter?.end ?? range.end };
  const oldText = (cutBefore?.oldText ?? '') + struckText + (cutAfter?.oldText ?? '');
  const written = writeMark(source, mergedRange, markupFor('deletion', oldText, ''));
  if (!written) return refused('swallowed');
  return applied(written, direction === 'forward' ? written.markEnd : mergedRange.start, null);
}

function deleteText(source: string, selection: SourceSelection, direction: 'backward' | 'forward', run: SuggestRun | null): SuggestOutcome {
  const runMark = activeRunMark(source, selection, run);
  if (runMark && direction === 'backward') return rewriteRunMark(source, runMark, runMark.newText.slice(0, -1));
  if (!isCollapsed(selection)) return strike(source, selection, direction);
  const struckOffset = direction === 'backward' ? selection.start - 1 : selection.start;
  if (!isPlainCharAt(source, struckOffset)) return refused('nothing');
  return strike(source, { start: struckOffset, end: struckOffset + 1 }, direction);
}

function insertNote(source: string, selection: SourceSelection, body: string): SuggestOutcome {
  const trimmedBody = body.trim();
  if (trimmedBody === '') return refused('nothing');
  const selectedText = source.slice(selection.start, selection.end);
  if (holdsMarkupDelimiter(trimmedBody) || holdsMarkupDelimiter(selectedText)) return refused('delimiter');
  const noteMarkup = `${NOTE_OPENER}${trimmedBody}${NOTE_CLOSER}`;
  if (!isCollapsed(selection)) return appliedNote(writeMark(source, selection, `{==${selectedText}==}${noteMarkup}`));
  const wouldBecomeTrailingNote = marksOf(source).some((mark) => mark.end === selection.start && mark.markKind !== 'comment' && !source.slice(mark.start, mark.end).endsWith(NOTE_CLOSER));
  return appliedNote(writeMark(source, selection, noteMarkup, wouldBecomeTrailingNote ? `${NOTE_OPENER}${NOTE_CLOSER}` : ''));
}

function appliedNote(written: WrittenMark | null): SuggestOutcome {
  if (!written) return refused('swallowed');
  return applied(written, written.markEnd, null);
}

function isInPlainText(source: string, selection: SourceSelection) {
  if (isCollapsed(selection)) return !marksOf(source).some((mark) => mark.start < selection.start && selection.start < mark.end);
  return parseCriticMarkup(source).some((segment) => segment.kind === 'text' && segment.start <= selection.start && selection.end <= segment.start + segment.text.length);
}

export function suggestEdit(source: string, edit: SuggestEdit, run: SuggestRun | null): SuggestOutcome {
  if (!isInPlainText(source, edit.selection)) return refused('nested');
  switch (edit.kind) {
    case 'type': return typeText(source, edit.selection, edit.text, run);
    case 'delete': return deleteText(source, edit.selection, edit.direction, run);
    case 'paragraph': return insertNote(source, { start: edit.selection.end, end: edit.selection.end }, 'para');
    case 'note': return isCollapsed(edit.selection) ? refused('nothing') : insertNote(source, edit.selection, edit.body);
  }
}
