import { INITIAL_LOOP_GUARD_STATE, decideLoopGuard, readLoopGuardLimits, reduceLoopGuard } from '../core/loop-guard-core.ts';
import type { Session } from '../../session/sessions.ts';
import { errorMessage } from '../../shared/text.ts';

type GuardedSession = Pick<Session, 'id' | 'ephemeral' | 'hasOwnWorktree' | 'worktreeLifecycle' | 'raiseAttention' | 'killSession' | 'on'>;

function createLoopGuardWiring({ getLoopGuardConfig, logger }: { getLoopGuardConfig: () => unknown; logger: Pick<Console, 'warn'> }) {
  function attachSession(session: GuardedSession): void {
    if (session.ephemeral) return;
    let state = INITIAL_LOOP_GUARD_STATE;

    async function checkTurnEnd(): Promise<void> {
      const limits = readLoopGuardLimits(getLoopGuardConfig());
      if (limits.maxTurnsWithoutProgress === null || !session.hasOwnWorktree) return;
      const tree = await session.worktreeLifecycle.computeWorktreeSignature();
      state = reduceLoopGuard(state, { kind: 'turn-end', sig: tree?.sig ?? null });
      const decision = decideLoopGuard(state, limits);
      if (decision.kind === 'ok') return;
      state = reduceLoopGuard(state, { kind: 'acted' });
      session.raiseAttention('loop-guard', decision.reason);
      if (decision.kind === 'stop') session.killSession();
    }

    session.on('operator-input', () => {
      state = reduceLoopGuard(state, { kind: 'operator-input' });
    });
    session.on('post-turn-check', () => {
      checkTurnEnd().catch((error: unknown) => logger.warn(`[loop-guard] ${session.id}: ${errorMessage(error)}`));
    });
  }

  return { attachSession };
}

export { createLoopGuardWiring };
