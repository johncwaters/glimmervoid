import { z } from 'zod';
import { REACTION_COOLDOWN_MINUTES_RANGE } from '../settings-ranges.ts';

const REACTION_TRIGGERS = ['session-failed', 'session-done', 'needs-attention', 'commits-landed'] as const;
const WAKEABLE_TRIGGERS: readonly string[] = ['needs-attention', 'commits-landed'];
const REACTIONS_MAX_COUNT = 20;

const Reaction = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, { error: 'a reaction id is lowercase letters, digits and dashes, at most 40' }),
  on: z.enum(REACTION_TRIGGERS).describe('session-failed, session-done, needs-attention or commits-landed'),
  project: z.string().min(1).max(4096).optional().describe('Only sessions in this project folder; absent reacts to every session'),
  action: z.enum(['notify', 'wake']).describe('notify raises an attention note on the session card; wake types text into the session once it is idle'),
  text: z.string().trim().min(1).max(2000).optional().describe('wake: the text typed into the session'),
}).superRefine((reaction, context) => {
  if (reaction.action === 'wake' && reaction.text === undefined) context.addIssue({ code: 'custom', path: ['text'], message: 'a wake reaction needs the text to type' });
  if (reaction.action === 'wake' && !WAKEABLE_TRIGGERS.includes(reaction.on)) context.addIssue({ code: 'custom', path: ['action'], message: `${reaction.on} ends the session, so it can only notify` });
});
export type Reaction = z.infer<typeof Reaction>;
export type ReactionTrigger = Reaction['on'];

export const ReactionsBlock = z.strictObject({
  reactions: z.array(Reaction).max(REACTIONS_MAX_COUNT).superRefine((reactions, context) => {
    const seenIds = new Set<string>();
    reactions.forEach((reaction, index) => {
      if (seenIds.has(reaction.id)) context.addIssue({ code: 'custom', path: [index, 'id'], message: `the id '${reaction.id}' is already used in reactions` });
      seenIds.add(reaction.id);
    });
  }).default([]),
  cooldownMinutes: z.number().int().min(REACTION_COOLDOWN_MINUTES_RANGE.min).max(REACTION_COOLDOWN_MINUTES_RANGE.max).default(10).describe('How long one reaction waits before reacting to the same session again'),
});
