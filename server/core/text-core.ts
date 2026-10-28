const OTHER_CATEGORY_RE = /\p{C}+/gu;

function firstLine(text: unknown): string {
  return String(text ?? '').split(/\r?\n/)[0].trim();
}

function sanitizeOneLine(raw: unknown, maxChars: number): string {
  const value = String(raw ?? '')
    .replace(OTHER_CATEGORY_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value.slice(0, maxChars).trim();
}

const MIN_CUT_HOME_PREFIX_CHARS = 2;

function comparableText(text: string): string {
  return text.replaceAll('\\', '/').toLowerCase();
}

function homeFolderPattern(homeDir: string): RegExp {
  const escapedParts = homeDir.split(/[\\/]/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escapedParts.join('[\\\\/]'), 'gi');
}

function replaceCutHomePrefixAtEnd(text: string, homeDir: string): string {
  const longestCandidate = Math.min(homeDir.length - 1, text.length);
  for (let prefixLength = longestCandidate; prefixLength >= MIN_CUT_HOME_PREFIX_CHARS; prefixLength -= 1) {
    if (comparableText(text.slice(-prefixLength)) === comparableText(homeDir.slice(0, prefixLength))) return `${text.slice(0, -prefixLength)}~`;
  }
  return text;
}

function showHomeAsTilde(text: string, homeDir: string): string {
  const trimmedHomeDir = homeDir.replace(/[\\/]+$/, '');
  if (!trimmedHomeDir) return text;
  return replaceCutHomePrefixAtEnd(text.replace(homeFolderPattern(trimmedHomeDir), '~'), trimmedHomeDir);
}

export { firstLine, sanitizeOneLine, showHomeAsTilde };
