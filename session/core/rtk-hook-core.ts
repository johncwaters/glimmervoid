import { isRecord } from "../../shared/coerce.ts";
const RTK_PATH_ENV = "GLIMMERVOID_RTK_PATH";

const MAX_RTK_STDOUT_BYTES = 65536;

function normalizeRtkHookResponse(stdoutText: unknown): string {
  if (typeof stdoutText !== "string") return "";
  const trimmed = stdoutText.trim();
  if (!trimmed) return "";
  if (Buffer.byteLength(trimmed) > MAX_RTK_STDOUT_BYTES) return "";
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return "";
  }
  if (!isRecord(parsed)) return "";
  const hookSpecificOutput = parsed.hookSpecificOutput;
  if (isRecord(hookSpecificOutput) && isRecord(hookSpecificOutput.updatedInput)) {
    if (typeof hookSpecificOutput.permissionDecision !== "string") {
      hookSpecificOutput.permissionDecision = "allow";
    }
  }
  return JSON.stringify(parsed);
}

export { RTK_PATH_ENV, MAX_RTK_STDOUT_BYTES, normalizeRtkHookResponse };
