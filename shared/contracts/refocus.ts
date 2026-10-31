import { z } from 'zod';

export const SessionStartHookResponse = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal('SessionStart'),
    additionalContext: z.string(),
  }),
});

export type SessionStartHookResponse = z.infer<typeof SessionStartHookResponse>;

export const UserPromptSubmitHookResponse = z.union([
  z.object({ message: z.string() }),
  z.object({ hookSpecificOutput: z.object({ hookEventName: z.literal('UserPromptSubmit'), additionalContext: z.string() }) }),
]);

export type UserPromptSubmitHookResponse = z.infer<typeof UserPromptSubmitHookResponse>;

export const ToolHookContextResponse = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.enum(['PostToolUse', 'PostToolUseFailure']),
    additionalContext: z.string(),
  }),
});

export type ToolHookContextResponse = z.infer<typeof ToolHookContextResponse>;

export const RelayedHookContext = z.union([UserPromptSubmitHookResponse, ToolHookContextResponse]);

export const PromptContextReply = z.enum(['message', 'additional-context']);

export type PromptContextReply = z.infer<typeof PromptContextReply>;
