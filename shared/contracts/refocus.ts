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
  z.object({ injectSteps: z.array(z.object({ userMessage: z.string().min(1) })).min(1) }),
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

export const QuestionToolDenyResponse = z.union([
  z.object({
    hookSpecificOutput: z.object({
      hookEventName: z.literal('PreToolUse'),
      permissionDecision: z.literal('deny'),
      permissionDecisionReason: z.string().min(1),
    }),
  }),
  z.object({
    decision: z.literal('deny'),
    reason: z.string().min(1),
  }),
]);

export type QuestionToolDenyResponse = z.infer<typeof QuestionToolDenyResponse>;

export const QuestionDenyReply = z.enum(['hook-specific-output', 'decision']);

export type QuestionDenyReply = z.infer<typeof QuestionDenyReply>;

export const PromptContextReply = z.enum(['message', 'additional-context', 'inject-steps']);

export type PromptContextReply = z.infer<typeof PromptContextReply>;

export const RESUME_NOTE_HOOK_EVENT = 'resumenote';

export const REWAKE_RELAY_MODE = 'rewake';

export const ResumeNoteHookResponse = z.object({ resumeNote: z.string().min(1) });

export type ResumeNoteHookResponse = z.infer<typeof ResumeNoteHookResponse>;
