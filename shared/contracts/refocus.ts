import { z } from 'zod';

export const SessionStartHookResponse = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal('SessionStart'),
    additionalContext: z.string(),
  }),
});

export type SessionStartHookResponse = z.infer<typeof SessionStartHookResponse>;
