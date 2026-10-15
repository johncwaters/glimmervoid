import { isRecord } from "../../shared/coerce.ts";
const RTK_PATH_ENV = "GLIMMERVOID_RTK_PATH";
const CLAUDE_RELAY_FLAVOR = "claude";

const MAX_RTK_STDOUT_BYTES = 65536;

function rewriteDisclosure(rewrittenCommand: string): string {
  return `Glimmervoid's rtk hook ran this Bash call as \`${rewrittenCommand}\`, so its output is rtk's condensed form, not the raw command output. For the raw output, run the command as \`rtk proxy <command>\`.`;
}

function completeRewrite(hookSpecificOutput: Record<string, unknown>, rewrittenCommand: unknown, isForClaude: boolean): void {
  if (!isForClaude) {
    if (typeof hookSpecificOutput.permissionDecision !== "string") hookSpecificOutput.permissionDecision = "allow";
    return;
  }
  if (typeof rewrittenCommand !== "string" || hookSpecificOutput.additionalContext !== undefined) return;
  hookSpecificOutput.additionalContext = rewriteDisclosure(rewrittenCommand);
}

function normalizeRtkHookResponse(stdoutText: unknown, { isForClaude = false }: { isForClaude?: boolean } = {}): string {
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
    completeRewrite(hookSpecificOutput, hookSpecificOutput.updatedInput.command, isForClaude);
  }
  return JSON.stringify(parsed);
}

export { CLAUDE_RELAY_FLAVOR, RTK_PATH_ENV, MAX_RTK_STDOUT_BYTES, normalizeRtkHookResponse };
