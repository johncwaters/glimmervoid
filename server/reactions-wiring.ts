import type { Session } from '../session/sessions.ts';
import { clock } from '../shared/clock.ts';
import type { Reaction, ReactionTrigger } from '../shared/contracts/reactions.ts';
import { STATES } from '../shared/states.ts';
import type { SessionState } from '../shared/states.ts';
import { reactionsToFire, readReactionSettings } from './core/reactions-core.ts';

type ReactingSession = Pick<Session, 'id' | 'name' | 'path' | 'ephemeral' | 'on' | 'deliver' | 'raiseAttention'>;

const TRIGGER_BY_STATE: Partial<Record<SessionState, ReactionTrigger>> = {
  [STATES.FAILED]: 'session-failed',
  [STATES.DONE]: 'session-done',
  [STATES.WAITING]: 'needs-attention',
};

const TRIGGER_TEXT: Record<ReactionTrigger, string> = {
  'session-failed': 'failed',
  'session-done': 'ended',
  'needs-attention': 'needs your input',
  'commits-landed': 'landed commits',
};

const IDLE_STATES: readonly SessionState[] = [STATES.IDLE, STATES.COMPLETE];
const RUN_ENDED_STATES: readonly SessionState[] = [STATES.DONE, STATES.FAILED, STATES.DORMANT];

function createReactionsWiring({ readReactions, logger }: { readReactions: () => unknown; logger: Pick<Console, 'warn'> }) {
  function attachSession(session: ReactingSession): void {
    if (session.ephemeral) return;
    const lastFiredAtByReactionId = new Map<string, number>();
    const waitingWakeTriggerByReactionId = new Map<string, ReactionTrigger>();
    let submittedReactionWakeCount = 0;
    let isTurnFromReactionWake = false;

    function typeWake(reactionId: string, text: string, trigger: ReactionTrigger): void {
      const delivery = session.deliver(text, {
        when: 'idle',
        submit: true,
        onSettled: (settlement) => {
          if (settlement === 'submitted') submittedReactionWakeCount += 1;
        },
      });
      if (delivery.ok) {
        waitingWakeTriggerByReactionId.delete(reactionId);
        lastFiredAtByReactionId.set(reactionId, clock.nowMs());
        return;
      }
      if (delivery.reason === 'not-idle') {
        waitingWakeTriggerByReactionId.set(reactionId, trigger);
        return;
      }
      waitingWakeTriggerByReactionId.delete(reactionId);
      logger.warn(`[reactions] ${reactionId} could not wake ${session.name}: ${delivery.reason}`);
    }

    function fire(reaction: Reaction, trigger: ReactionTrigger, nowMs: number): void {
      if (reaction.action === 'wake') {
        typeWake(reaction.id, reaction.text ?? '', trigger);
        return;
      }
      lastFiredAtByReactionId.set(reaction.id, nowMs);
      const raised = session.raiseAttention('reaction', `${session.name} ${TRIGGER_TEXT[trigger]} (reaction ${reaction.id})`);
      if (!raised.ok) logger.warn(`[reactions] ${reaction.id} could not notify about ${session.name}: ${raised.error}`);
    }

    function dueReactions(trigger: ReactionTrigger, nowMs: number): Reaction[] {
      return reactionsToFire({ settings: readReactionSettings(readReactions()), trigger, projectPath: session.path, isTurnFromReactionWake, lastFiredAtByReactionId, nowMs });
    }

    function react(trigger: ReactionTrigger): void {
      const nowMs = clock.nowMs();
      for (const reaction of dueReactions(trigger, nowMs)) fire(reaction, trigger, nowMs);
    }

    function typeWaitingWakes(): void {
      const waiting = [...waitingWakeTriggerByReactionId];
      waitingWakeTriggerByReactionId.clear();
      for (const [reactionId, trigger] of waiting) {
        const reaction = dueReactions(trigger, clock.nowMs()).find((due) => due.id === reactionId && due.action === 'wake');
        if (reaction) typeWake(reaction.id, reaction.text ?? '', trigger);
      }
    }

    session.on('state-change', ({ to }: { to: SessionState }) => {
      if (RUN_ENDED_STATES.includes(to)) waitingWakeTriggerByReactionId.clear();
      if (IDLE_STATES.includes(to)) typeWaitingWakes();
      const trigger = TRIGGER_BY_STATE[to];
      if (trigger !== undefined) react(trigger);
    });
    session.on('commits-landed', () => react('commits-landed'));
    session.on('user-prompt', () => {
      isTurnFromReactionWake = submittedReactionWakeCount > 0;
      submittedReactionWakeCount = Math.max(0, submittedReactionWakeCount - 1);
    });
  }

  return { attachSession };
}

export { createReactionsWiring };
