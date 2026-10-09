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

export { errorCode, errorLabel, errorMessage, errorText, isMissingFileError };
