import type { z } from 'zod';

const COLON_WITH_EMPHASIS = /^[*_]*:[*_]*/;

function textAfterHeading(line: string, heading: string): string | null {
  const withoutMarkdown = line.trim().replace(/^[#*_\s]+/, '');
  const headingWord = heading.endsWith(':') ? heading.slice(0, -1) : heading;
  if (!withoutMarkdown.startsWith(headingWord)) return null;
  const afterWord = withoutMarkdown.slice(headingWord.length);
  if (headingWord === heading) return afterWord.replace(/^[*_]+/, '').trim();
  const colonWithEmphasis = COLON_WITH_EMPHASIS.exec(afterWord);
  if (!colonWithEmphasis) return null;
  return afterWord.slice(colonWithEmphasis[0].length).trim();
}

function isHeadingAmong(line: string, headings: readonly string[]): boolean {
  return headings.some((heading) => textAfterHeading(line, heading) !== null);
}

function sectionAfter(lines: readonly string[], heading: string, headings: readonly string[]): string[] | null {
  const headingIndex = lines.findIndex((line) => textAfterHeading(line, heading) !== null);
  if (headingIndex === -1) return null;
  const textOnHeadingLine = textAfterHeading(lines[headingIndex] ?? '', heading) ?? '';
  const sectionEnd = lines.findIndex((line, index) => index > headingIndex && isHeadingAmong(line, headings));
  const following = lines.slice(headingIndex + 1, sectionEnd === -1 ? undefined : sectionEnd);
  return textOnHeadingLine ? [textOnHeadingLine, ...following] : following;
}

const BULLET_MARKER = /^(?:[-*+]|\d+[.)])\s+/;
const NOTHING_TO_LIST = /^\(?none\)?\.?$/i;

function bulletsIn(sectionLines: readonly string[] | null): string[] {
  const items: string[] = [];
  const nonEmptyLines = (sectionLines ?? []).map((line) => line.trim()).filter((line) => line !== '');
  const usesBulletMarkers = nonEmptyLines.some((line) => BULLET_MARKER.test(line));
  for (const trimmed of nonEmptyLines) {
    const isNewItem = !usesBulletMarkers || BULLET_MARKER.test(trimmed) || items.length === 0;
    const text = trimmed.replace(BULLET_MARKER, '');
    if (isNewItem) {
      items.push(text);
      continue;
    }
    items[items.length - 1] = `${items[items.length - 1]} ${text}`;
  }
  return items.filter((item) => !NOTHING_TO_LIST.test(item));
}

function withoutControlCharacters(text: string): string {
  return Array.from(text, (character) => {
    const code = character.charCodeAt(0);
    if (character === '\n' || character === '\t') return character;
    return code < 32 || code === 127 ? ' ' : character;
  }).join('');
}

function fencedUntrusted(label: string, text: string, maxChars: number): string {
  const bounded = withoutControlCharacters(text.slice(0, maxChars)) || '(empty)';
  const longestBacktickRun = Math.max(0, ...Array.from(bounded.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}${label}\n${bounded}\n${fence}`;
}

function parsePostingFile<Plan>(json: string, schema: z.ZodType<Plan>, label: string): { ok: true; plan: Plan } | { ok: false; reason: string } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    return { ok: false, reason: `the ${label} is not JSON` };
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) return { ok: false, reason: `the ${label} is invalid: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}` };
  return { ok: true, plan: parsed.data };
}

export { bulletsIn, fencedUntrusted, isHeadingAmong, parsePostingFile, sectionAfter, textAfterHeading, withoutControlCharacters };
