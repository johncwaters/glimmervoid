const BRAILLE_MIN = 0x2800;
const BRAILLE_MAX = 0x28ff;
const CIRCLE_HALVES_SPINNER_CODEPOINTS = new Set([0x25d0, 0x25d1, 0x25d2, 0x25d3]);

function isBrailleChar(char: string | null | undefined): boolean {
  if (!char) return false;
  const codePoint = char.codePointAt(0) ?? 0;
  return codePoint >= BRAILLE_MIN && codePoint <= BRAILLE_MAX;
}

function isSpinnerChar(char: string | null | undefined): boolean {
  if (!char) return false;
  if (isBrailleChar(char)) return true;
  return CIRCLE_HALVES_SPINNER_CODEPOINTS.has(char.codePointAt(0) ?? 0);
}

function isPathLikeTitle(title: string): boolean {
  return title.includes("/") || title.includes("\\");
}

function firstCharOfTitle(title: string): string {
  if (title.length === 0) return "";
  return String.fromCodePoint(title.codePointAt(0) ?? 0);
}

interface TitleVocabulary {
  isSpinnerChar(char: string | null | undefined): boolean;
  busyTitle?: string | null;
  idleTitle?: string | null;
  classifyAgainstCwdBasename?(title: string, cwdBasename: string): string | null;
}

function classifyAgentTitle(
  title: string,
  { cwdBasename = null }: { cwdBasename?: string | null },
  vocabulary: TitleVocabulary,
): string {
  const trimmedTitle = title.trim();
  if (vocabulary.busyTitle && trimmedTitle === vocabulary.busyTitle) return "working";
  if (vocabulary.idleTitle && trimmedTitle === vocabulary.idleTitle) return "ready";
  if (isPathLikeTitle(title)) return "ignore";
  if (vocabulary.isSpinnerChar(firstCharOfTitle(title))) return "working";
  if (!cwdBasename) return "ignore";
  const cwdAwareClassification = vocabulary.classifyAgainstCwdBasename?.(title, cwdBasename) ?? null;
  if (cwdAwareClassification) return cwdAwareClassification;
  if (trimmedTitle === cwdBasename) return "ready";
  return "unknown";
}

export {
  BRAILLE_MAX,
  BRAILLE_MIN,
  classifyAgentTitle,
  firstCharOfTitle,
  isBrailleChar,
  isPathLikeTitle,
  isSpinnerChar,
};
export type { TitleVocabulary };
