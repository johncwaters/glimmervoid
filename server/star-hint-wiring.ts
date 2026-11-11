import type { EventEmitter } from 'node:events';
import { StarHintState } from '../shared/contracts/star-hint.ts';
import type { StarHintOutcome } from '../shared/contracts/star-hint.ts';
import { createJsonStateStore } from './json-file.ts';
import * as core from './core/star-hint-core.ts';
import type { HookEventNotice } from './core/star-hint-core.ts';

type StarHintMessage = { type: 'star-hint' };

interface StarHintWiringOptions {
  statePath: string | null;
  broadcast: (message: StarHintMessage) => void;
  log: Pick<Console, 'warn'>;
  controlClientCount?: () => number;
}

interface HintableSession extends Pick<EventEmitter, 'on' | 'off'> {
  readonly id: string;
  readonly ephemeral: boolean;
}

function createStarHintWiring({ statePath, broadcast, log, controlClientCount = () => 0 }: StarHintWiringOptions) {
  let state = core.emptyStarHintState();
  let isStopped = false;
  const attachedSessions = new WeakSet<HintableSession>();
  const store = createJsonStateStore({
    name: 'star hint', filePath: statePath,
    parse: (raw) => StarHintState.safeParse(raw).data ?? null,
    adopt: (loadedState) => { state = loadedState ?? core.emptyStarHintState(); },
    warn: (message, fields) => log.warn(`[star-hint] ${message} ${JSON.stringify(fields)}`),
  });
  const loaded = store.load();

  async function persist(): Promise<void> {
    const persistedState = state;
    await store.write(persistedState, () => `${JSON.stringify(persistedState, null, 2)}\n`);
  }

  function takeStarHint(): boolean {
    if (!core.isStarHintPending(state)) return false;
    state = core.settleStarHint(state, 'shown');
    return true;
  }

  function update(nextStateOf: (current: StarHintState) => StarHintState): Promise<void> {
    return loaded.then(() => {
      if (isStopped) return;
      state = nextStateOf(state);
      if (controlClientCount() > 0 && takeStarHint()) broadcast({ type: 'star-hint' });
      return persist();
    });
  }

  function attachSession(session: HintableSession): void {
    if (attachedSessions.has(session) || session.ephemeral) return;
    attachedSessions.add(session);
    function onHookEvent(notice: HookEventNotice): void {
      if (core.isOperatorPromptEvent(notice)) void update(core.countStarHintPrompt);
    }
    function detach(): void {
      session.off('hook-event', onHookEvent);
      session.off('teardown', detach);
    }
    session.on('hook-event', onHookEvent);
    session.on('teardown', detach);
  }

  function settleStar(outcome: StarHintOutcome): Promise<void> {
    return update((current) => core.settleStarHint(current, outcome));
  }

  function pendingHintMessages(): StarHintMessage[] {
    if (isStopped || !takeStarHint()) return [];
    void persist();
    return [{ type: 'star-hint' }];
  }

  function idle(): Promise<void> {
    return loaded.then(() => store.idle());
  }

  async function stop(): Promise<void> {
    isStopped = true;
    await idle();
  }

  return { attachSession, settleStar, pendingHintMessages, stop, idle };
}

type StarHintWiring = ReturnType<typeof createStarHintWiring>;

export { createStarHintWiring };
export type { StarHintWiring };
