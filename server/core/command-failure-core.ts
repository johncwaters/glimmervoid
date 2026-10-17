export function isCompletedCommandFailure(error: unknown): error is Error & { code: number } {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number') return false;
  return !('killed' in error && error.killed === true);
}
