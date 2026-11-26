function errorCodeOf(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  return String(error.code || "");
}

function isBenignPtySocketError(error: unknown): boolean {
  const code = errorCodeOf(error);
  if (code.includes("EAGAIN")) return true;
  return code.includes("EIO") || code.includes("errno 5");
}

export { isBenignPtySocketError };
