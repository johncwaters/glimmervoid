import type { Session } from '../session/sessions.ts';
import { clock } from '../shared/clock.ts';
import type { ReactionTrigger } from '../shared/contracts/reactions.ts';
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

function createReactionsWiring({ readReactions, logger }: { readReactions: () => unknown; logger: Pick<Console, 'warn'> }) {
  function attachSession(session: ReactingSession): void {
    if (session.ephemeral) return;
    const lastFiredAtByReactionId = new Map<string, number>();
    let submittedReactionWakeCount = 0;
    let isTurnFromReactionWake = false;

    function react(trigger: ReactionTrigger): void {
      const nowMs = clock.nowMs();
      const due = reactionsToFire({ settings: readReactionSettings(readReactions()), trigger, projectPath: session.path, isTurnFromReactionWake, lastFiredAtByReactionId, nowMs });
      for (const reaction of due) {
        lastFiredAtByReactionId.set(reaction.id, nowMs);
        if (reaction.action === 'notify') {
          const raised = session.raiseAttention('reaction', `${session.name} ${TRIGGER_TEXT[trigger]} (reaction ${reaction.id})`);
          if (!raised.ok) logger.warn(`[reactions] ${reaction.id} could not notify about ${session.name}: ${raised.error}`);
          continue;
        }
        session.deliver(reaction.text ?? '', {
          when: 'idle',
          submit: true,
          onSettled: (settlement) => {
            if (settlement === 'submitted') submittedReactionWakeCount += 1;
          },
        });
      }
    }

    session.on('state-change', ({ to }: { to: SessionState }) => {
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
