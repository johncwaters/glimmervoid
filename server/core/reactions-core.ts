import { ReactionsBlock } from '../../shared/contracts/reactions.ts';
import type { Reaction, ReactionTrigger } from '../../shared/contracts/reactions.ts';

const MS_PER_MINUTE = 60_000;

type ReactionSettings = { reactions: Reaction[]; cooldownMs: number };

function readReactionSettings(raw: unknown): ReactionSettings {
  const parsed = ReactionsBlock.safeParse(raw ?? {});
  if (!parsed.success) return { reactions: [], cooldownMs: 0 };
  return { reactions: parsed.data.reactions, cooldownMs: parsed.data.cooldownMinutes * MS_PER_MINUTE };
}

function withoutTrailingSeparators(folder: string): string {
  return folder.replace(/[\\/]+$/, '');
}

function reactionsToFire({ settings, trigger, projectPath, isTurnFromReactionWake, lastFiredAtByReactionId, nowMs }: {
  settings: ReactionSettings;
  trigger: ReactionTrigger;
  projectPath: string;
  isTurnFromReactionWake: boolean;
  lastFiredAtByReactionId: ReadonlyMap<string, number>;
  nowMs: number;
}): Reaction[] {
  return settings.reactions.filter((reaction) => {
    if (reaction.on !== trigger) return false;
    if (reaction.project !== undefined && withoutTrailingSeparators(reaction.project) !== withoutTrailingSeparators(projectPath)) return false;
    if (reaction.action === 'wake' && isTurnFromReactionWake) return false;
    const lastFiredAt = lastFiredAtByReactionId.get(reaction.id);
    return lastFiredAt === undefined || nowMs - lastFiredAt >= settings.cooldownMs;
  });
}

export { reactionsToFire, readReactionSettings };
