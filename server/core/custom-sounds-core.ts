import path from 'node:path';

const CUSTOM_SOUNDS_DIRNAME = 'sounds';
const MAX_SOUND_NAME_LENGTH = 255;

const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.webm': 'audio/webm',
});

function hasControlCharacter(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) < 0x20 || name.charCodeAt(i) === 0x7f) return true;
  }
  return false;
}

function customSoundContentType(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  if (name.length === 0 || name.length > MAX_SOUND_NAME_LENGTH) return null;
  if (name.startsWith('.')) return null;
  if (/[/\\:]/.test(name) || hasControlCharacter(name)) return null;
  return CONTENT_TYPE_BY_EXTENSION[path.extname(name).toLowerCase()] ?? null;
}

function isCustomSoundName(name: unknown): name is string {
  return customSoundContentType(name) !== null;
}

function selectCustomSoundNames(entries: readonly { name: string; isFile: boolean }[]): string[] {
  return entries
    .filter((entry) => entry.isFile && isCustomSoundName(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function isDirectChildOf(realDirectory: string, realCandidate: string): boolean {
  return path.dirname(path.resolve(realCandidate)) === path.resolve(realDirectory);
}

function resolveCustomSoundsDir(glimmervoidHome: string): string {
  return path.join(glimmervoidHome, CUSTOM_SOUNDS_DIRNAME);
}

type ByteRangeDecision =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

const SERVE_FULL_FILE: ByteRangeDecision = Object.freeze({ kind: 'full' });
const SINGLE_BYTE_RANGE = /^bytes=(\d*)-(\d*)$/i;

function decideSuffixRange(suffixLength: number, sizeBytes: number): ByteRangeDecision {
  if (suffixLength === 0 || sizeBytes === 0) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start: Math.max(0, sizeBytes - suffixLength), end: sizeBytes - 1 };
}

function decideByteRange(rangeHeader: unknown, sizeBytes: number): ByteRangeDecision {
  if (typeof rangeHeader !== 'string') return SERVE_FULL_FILE;
  const rangeMatch = rangeHeader.trim().match(SINGLE_BYTE_RANGE);
  if (!rangeMatch) return SERVE_FULL_FILE;
  const [, startDigits, endDigits] = rangeMatch;
  if (!startDigits && !endDigits) return SERVE_FULL_FILE;
  if (!startDigits) return decideSuffixRange(Number(endDigits), sizeBytes);
  const start = Number(startDigits);
  const requestedEnd = endDigits ? Number(endDigits) : Number.POSITIVE_INFINITY;
  if (requestedEnd < start) return SERVE_FULL_FILE;
  if (start >= sizeBytes) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end: Math.min(requestedEnd, sizeBytes - 1) };
}

export type { ByteRangeDecision };
export {
  customSoundContentType,
  decideByteRange,
  isCustomSoundName,
  isDirectChildOf,
  resolveCustomSoundsDir,
  selectCustomSoundNames,
};
