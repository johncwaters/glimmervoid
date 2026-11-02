const MARGIN_CODES = ['wc', 'awk', 'frag', 'tense', 'unclear', 'para', 'good', 'must', 'end'] as const;
type MarginCode = (typeof MARGIN_CODES)[number];

type MarkKind = 'deletion' | 'insertion' | 'substitution' | 'highlight' | 'comment';
export type MarkDecision = 'accept' | 'reject';
export type OperatorMarkAction = 'strike' | 'insert' | 'replace' | 'note';

interface MarginNote {
  code: MarginCode | null;
  body: string;
}

interface TextSegment {
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

export type MarkupSegment = TextSegment | MarkSegment;

export interface SourceSelection {
  start: number;
  end: number;
}

const TRAILING_NOTE = String.raw`(?:\{>>([\s\S]*?)<<\})?`;
const CRITIC_MARKUP_PATTERN = new RegExp([
  String.raw`\{--([\s\S]*?)--\}${TRAILING_NOTE}`,
  String.raw`\{\+\+([\s\S]*?)\+\+\}${TRAILING_NOTE}`,
  String.raw`\{~~([\s\S]*?)~>([\s\S]*?)~~\}${TRAILING_NOTE}`,
  String.raw`\{==([\s\S]*?)==\}${TRAILING_NOTE}`,
  String.raw`\{>>([\s\S]*?)<<\}`,
].join('|'), 'g');
const MARGIN_CODE_PATTERN = new RegExp(`^(${MARGIN_CODES.join('|')}):\\s*`, 'i');

function isMarginCode(candidate: string): candidate is MarginCode {
  return (MARGIN_CODES as readonly string[]).includes(candidate);
}

function parseMarginNote(rawNote: string | undefined): MarginNote | null {
  if (rawNote === undefined) return null;
  const codeMatch = MARGIN_CODE_PATTERN.exec(rawNote);
  const code = codeMatch?.[1]?.toLowerCase() ?? '';
  if (!codeMatch || !isMarginCode(code)) return { code: null, body: rawNote.trim() };
  return { code, body: rawNote.slice(codeMatch[0].length).trim() };
}

function markFromMatch(match: RegExpExecArray): MarkSegment {
  const start = match.index;
  const end = start + match[0].length;
  const base = { kind: 'mark' as const, start, end };
  if (match[1] !== undefined) return { ...base, markKind: 'deletion', oldText: match[1], newText: '', note: parseMarginNote(match[2]) };
  if (match[3] !== undefined) return { ...base, markKind: 'insertion', oldText: '', newText: match[3], note: parseMarginNote(match[4]) };
  if (match[5] !== undefined) return { ...base, markKind: 'substitution', oldText: match[5], newText: match[6] ?? '', note: parseMarginNote(match[7]) };
  if (match[8] !== undefined) return { ...base, markKind: 'highlight', oldText: match[8], newText: '', note: parseMarginNote(match[9]) };
  return { ...base, markKind: 'comment', oldText: '', newText: '', note: parseMarginNote(match[10]) };
}

export function parseCriticMarkup(source: string): MarkupSegment[] {
  const segments: MarkupSegment[] = [];
  let copiedUpTo = 0;
  for (const match of source.matchAll(CRITIC_MARKUP_PATTERN)) {
    if (match.index > copiedUpTo) segments.push({ kind: 'text', start: copiedUpTo, text: source.slice(copiedUpTo, match.index) });
    segments.push(markFromMatch(match));
    copiedUpTo = match.index + match[0].length;
  }
  if (copiedUpTo < source.length) segments.push({ kind: 'text', start: copiedUpTo, text: source.slice(copiedUpTo) });
  return segments;
}

export function marksOf(segments: MarkupSegment[]): MarkSegment[] {
  return segments.filter((segment): segment is MarkSegment => segment.kind === 'mark');
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

export function canApplyOperatorMark(action: OperatorMarkAction, selection: SourceSelection | null, operatorText: string): boolean {
  if (!selection) return false;
  const hasSelectedText = selection.end > selection.start;
  const hasOperatorText = operatorText.trim().length > 0;
  switch (action) {
    case 'strike': return hasSelectedText;
    case 'insert': return !hasSelectedText && hasOperatorText;
    case 'replace': return hasSelectedText && hasOperatorText;
    case 'note': return hasSelectedText && hasOperatorText;
  }
}

export function applyOperatorMark(source: string, action: OperatorMarkAction, selection: SourceSelection, operatorText: string): string {
  const selectedText = source.slice(selection.start, selection.end);
  return source.slice(0, selection.start) + markupFor(action, selectedText, operatorText) + source.slice(selection.end);
}

export function agentPromptFor(docPath: string, openMarkCount: number): string {
  return [
    `I marked up ${docPath} in red pen: ${openMarkCount} open CriticMarkup marks.`,
    'Read the file. For each {--cut--}, {++add++} and {~~old~>new~~} apply it unless you disagree, {==text==}{>>note<<} is my note on that text.',
    'A note may start with a margin code: wc word choice, awk awkward, frag fragment, tense, unclear, para new paragraph, must required, good keep this, end overall note.',
    'Remove every mark once handled, then tell me which ones you pushed back on and why.',
  ].join('\n');
}
