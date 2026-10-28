import { z } from 'zod';

export const SessionStartHookResponse = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal('SessionStart'),
    additionalContext: z.string(),
  }),
});

export type SessionStartHookResponse = z.infer<typeof SessionStartHookResponse>;

export const UserPromptSubmitHookResponse = z.object({
  message: z.string(),
});

export type UserPromptSubmitHookResponse = z.infer<typeof UserPromptSubmitHookResponse>;
