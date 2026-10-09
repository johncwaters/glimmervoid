const OTHER_CATEGORY_RE = /\p{C}+/gu;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

export { errorMessage, firstLine, sanitizeOneLine };
