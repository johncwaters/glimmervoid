const SECRET_WORD = '(?:password|passwd|pwd|token|api[_-]?key|secret|credential|auth[_-]?token|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|connection[_-]?string)';
const QUOTED_OR_BARE = '(?:"[^"\\r\\n]*"|\'[^\'\\r\\n]*\'|[^\\s\\r\\n]+)';
const GAP = '[^\\S\\r\\n]';

const ASSIGNMENT_PREFIX = `${SECRET_WORD}${GAP}*(?:=>|[:=])${GAP}*`;
const QUERY_PARAMETER_LEAD = '[?&][A-Za-z0-9_.-]*';
const FLAG_REACH = '[^\\r\\n;&|]{0,200}?';
const MYSQL_TOOLS = '(?:mysql|mysqldump|mysqladmin|mysqlshow|mariadb|mariadb-dump)';

const SECRET_ASSIGNMENT_PATTERN = new RegExp(`(${ASSIGNMENT_PREFIX})${QUOTED_OR_BARE}`, 'gi');
const BEARER_VALUE_PATTERN = new RegExp(`(\\bBearer${GAP}+)[A-Za-z0-9._~+/=-]{8,}`, 'gi');

const SECRET_SHAPE_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bph[cx]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_=-]{6,}\.[A-Za-z0-9_=-]{6,}\.[A-Za-z0-9_=-]{4,}/g,
  /-----BEGIN(?:[A-Z0-9 ]+)? PRIVATE KEY-----/g,
];

const COMMAND_FLAG_SECRET_PATTERNS = [
  new RegExp(`((?:^|\\s)--?${SECRET_WORD}${GAP}+)${QUOTED_OR_BARE}`, 'gi'),
  new RegExp(`((?:^|\\s)-(?:pwd|pw)(?![a-z])${GAP}*=?${GAP}*)${QUOTED_OR_BARE}`, 'g'),
  new RegExp(`(-AsPlainText${GAP}+)${QUOTED_OR_BARE}`, 'gi'),
  new RegExp(`((?:^|\\s)setx${GAP}+[^\\s\\r\\n]*${SECRET_WORD}[^\\s\\r\\n]*${GAP}+)${QUOTED_OR_BARE}`, 'gi'),
];

const COMMAND_CREDENTIAL_PATTERNS = [
  new RegExp(`(\\bauthorization${GAP}*:${GAP}*Basic${GAP}+)[A-Za-z0-9+/=_-]{8,}`, 'gi'),
  new RegExp(`(\\bdocker${GAP}+login\\b${FLAG_REACH}${GAP}-p(?:${GAP}+|=))${QUOTED_OR_BARE}`, 'gi'),
  new RegExp(`(\\bcurl\\b${FLAG_REACH}${GAP}(?:--user|-u)(?:${GAP}+|=)[^\\s:\\r\\n]+:)${QUOTED_OR_BARE}`, 'gi'),
  new RegExp(`(\\b${MYSQL_TOOLS}\\b${FLAG_REACH}${GAP}-p)${QUOTED_OR_BARE}`, 'g'),
  /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi,
];

const PEM_KEY_LINE_PATTERNS = [
  /-----END(?:[A-Z0-9 ]+)? PRIVATE KEY-----/g,
  /^([^\S\r\n]*)(?=[A-Za-z0-9+/]*[g-zG-Z+/])(?=[A-Za-z0-9+/=]{60,76}[^\S\r\n]*$)[A-Za-z0-9+/]+={0,2}(?=[^\S\r\n]*$)/gm,
];

const QUERY_VALUE_PATTERN = new RegExp(`(${QUERY_PARAMETER_LEAD}(?:${SECRET_WORD}|_key)=)[^&#\\s]+`, 'gi');
const ENV_NAME_ASSIGNMENT_PATTERN = new RegExp(`(\\b(?=[A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD))[A-Z][A-Z0-9_]*=)${QUOTED_OR_BARE}`, 'g');

const PATTERNS_YIELDING_TO_QUERY_VALUES = [SECRET_ASSIGNMENT_PATTERN, ENV_NAME_ASSIGNMENT_PATTERN];
const INDEPENDENT_PATTERNS = [
  BEARER_VALUE_PATTERN,
  ...COMMAND_FLAG_SECRET_PATTERNS,
  ...COMMAND_CREDENTIAL_PATTERNS,
  ...SECRET_SHAPE_PATTERNS,
  ...PEM_KEY_LINE_PATTERNS,
];

type SecretRange = { start: number; end: number };

type MatchSpan = { matchStart: number; valueStart: number; end: number };

function matchSpans(text: string, pattern: RegExp): MatchSpan[] {
  return [...text.matchAll(pattern)].map((match) => ({
    matchStart: match.index,
    valueStart: match.index + (match[1] ?? '').length,
    end: match.index + match[0].length,
  }));
}

function spansOutsideQueryValues(spans: MatchSpan[], querySpans: MatchSpan[]): MatchSpan[] {
  let queryIndex = 0;
  return spans.filter((span) => {
    while (queryIndex < querySpans.length && querySpans[queryIndex].end <= span.matchStart) queryIndex += 1;
    const enclosingCandidate = querySpans.at(queryIndex);
    return !enclosingCandidate || span.matchStart < enclosingCandidate.matchStart;
  });
}

function mergeOverlapping(ranges: SecretRange[]): SecretRange[] {
  const merged: SecretRange[] = [];
  for (const range of ranges.toSorted((left, right) => left.start - right.start)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

export function findSecretRanges(text: string): SecretRange[] {
  const querySpans = matchSpans(text, QUERY_VALUE_PATTERN);
  const spans = [
    ...querySpans,
    ...PATTERNS_YIELDING_TO_QUERY_VALUES.flatMap((pattern) => spansOutsideQueryValues(matchSpans(text, pattern), querySpans)),
    ...INDEPENDENT_PATTERNS.flatMap((pattern) => matchSpans(text, pattern)),
  ];
  return mergeOverlapping(spans.map((span) => ({ start: span.valueStart, end: span.end })));
}

const SECRET_MASK = String.fromCharCode(0x2022).repeat(8);
const MIN_MASKED_VALUE_LENGTH = 4;

function deliveredValuePieces(deliveredValues: readonly string[]): string[] {
  const pieces = deliveredValues.flatMap((value) => [value, ...value.split(/\r?\n/)]).map((piece) => piece.trim());
  return [...new Set(pieces.filter((piece) => piece.length >= MIN_MASKED_VALUE_LENGTH))];
}

function pieceRanges(text: string, pieces: readonly string[]): SecretRange[] {
  const ranges: SecretRange[] = [];
  for (const piece of pieces) {
    for (let start = text.indexOf(piece); start !== -1; start = text.indexOf(piece, start + piece.length)) ranges.push({ start, end: start + piece.length });
  }
  return ranges;
}

function deliveredValueRanges(text: string, deliveredValues: readonly string[]): SecretRange[] {
  return pieceRanges(text, deliveredValuePieces(deliveredValues));
}

export function deliveredValuePrefixLength(text: string, deliveredValues: readonly string[]): number {
  const lastMaskedEnd = deliveredValueRanges(text, deliveredValues).reduce((latestEnd, range) => Math.max(latestEnd, range.end), 0);
  let longestPrefixLength = 0;
  for (const piece of deliveredValuePieces(deliveredValues)) {
    for (let prefixLength = Math.min(piece.length - 1, text.length - lastMaskedEnd); prefixLength > longestPrefixLength; prefixLength--) {
      if (text.endsWith(piece.slice(0, prefixLength))) longestPrefixLength = prefixLength;
    }
  }
  return longestPrefixLength;
}

function maskRanges(text: string, secretRanges: readonly SecretRange[]): string {
  if (secretRanges.length === 0) return text;
  let maskedText = '';
  let copiedUpTo = 0;
  for (const range of secretRanges) {
    maskedText += text.slice(copiedUpTo, range.start) + SECRET_MASK;
    copiedUpTo = range.end;
  }
  return maskedText + text.slice(copiedUpTo);
}

export function maskSecrets(text: string, deliveredValues: readonly string[] = []): string {
  return maskRanges(text, mergeOverlapping([...findSecretRanges(text), ...deliveredValueRanges(text, deliveredValues)]));
}

export function deliveredValueMasker(deliveredValues: readonly string[]): (text: string) => string {
  const pieces = deliveredValuePieces(deliveredValues);
  return (text) => maskRanges(text, mergeOverlapping(pieceRanges(text, pieces)));
}

export function maskSecretStrings(value: unknown, deliveredValues: readonly string[] = [], maskText: (text: string) => string = (text) => maskSecrets(text, deliveredValues)): unknown {
  if (typeof value === 'string') return maskText(value);
  if (Array.isArray(value)) return value.map((item) => maskSecretStrings(item, deliveredValues, maskText));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskSecretStrings(item, deliveredValues, maskText)]));
}
