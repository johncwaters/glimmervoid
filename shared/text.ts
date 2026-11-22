function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorText(error: unknown): string {
  const failure = (error ?? {}) as { message?: unknown };
  return failure.message ? String(failure.message) : String(error);
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function errorLabel(error: unknown): string {
  return errorCode(error) || errorText(error);
}

function isMissingFileError(error: unknown, { includeNotDir = true }: { includeNotDir?: boolean } = {}): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || (includeNotDir && code === 'ENOTDIR');
}

function firstCodePoints(text: string, maxCodePoints: number): string {
  return Array.from(text).slice(0, maxCodePoints).join('');
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function splitLines(carry: string | null | undefined, chunkText: string | null | undefined): { lines: string[]; carry: string } {
  const text = `${carry || ''}${chunkText || ''}`;
  const lines = text.split(/\r?\n/);
  const nextCarry = text.endsWith('\n') || text.endsWith('\r\n') ? '' : lines.pop();
  return { lines: lines.filter((line) => line.length > 0), carry: nextCarry || '' };
}

export { errorCode, errorLabel, errorMessage, errorText, firstCodePoints, isMissingFileError, shellQuote, splitLines };
