import type { PermissionHookReply } from '../../session/core/claude-approval-core.ts';

export function permissionRequestDecisionOf(reply: PermissionHookReply | null | undefined): Record<string, unknown> | null {
  if (!reply || !('hookSpecificOutput' in reply) || !('decision' in reply.hookSpecificOutput)) return null;
  return reply.hookSpecificOutput.decision;
}
