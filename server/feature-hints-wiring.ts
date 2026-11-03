import type { EventEmitter } from 'node:events';
import { FeatureHintState } from '../shared/contracts/feature-hints.ts';
import type { FeatureHint, HintFeature, HintOutcome, StarHintOutcome } from '../shared/contracts/feature-hints.ts';
import { valueAtPath } from '../shared/settings/registry-core.ts';
import { createJsonStateStore } from './json-file.ts';
import * as core from './core/feature-hints-core.ts';
import type { FeatureSignal, HookEventNotice, RecentPrompt } from './core/feature-hints-core.ts';

type FeatureHintMessage = { type: 'feature-hint'; hint: FeatureHint };
type StarHintMessage = { type: 'star-hint' };

interface FeatureHintsWiringOptions {
  statePath: string | null;
  broadcast: (message: FeatureHintMessage | StarHintMessage) => void;
  log: Pick<Console, 'warn'>;
  currentConfig: () => unknown;
  now?: () => number;
}

interface HintableSession extends Pick<EventEmitter, 'on' | 'off'> {
  readonly id: string;
  readonly ephemeral: boolean;
}

function createFeatureHintsWiring({ statePath, broadcast, log, currentConfig, now = Date.now }: FeatureHintsWiringOptions) {
  let state = core.emptyFeatureHintState();
  let recentPrompts: readonly RecentPrompt[] = [];
  let isStopped = false;
  const areHintCardsEnabled = () => valueAtPath(currentConfig(), 'hintCards') === true;
  const isFeatureEnabled: core.IsFeatureEnabled = (feature) => core.isHintFeatureEnabledIn(currentConfig(), feature);
  const attachedSessions = new WeakSet<HintableSession>();
  const store = createJsonStateStore({
    name: 'feature hints', filePath: statePath,
    parse: (raw) => FeatureHintState.safeParse(raw).data ?? null,
    adopt: (loadedState) => { state = core.withoutStaleHint(loadedState ?? core.emptyFeatureHintState(), now(), isFeatureEnabled); },
    warn: (message, fields) => log.warn(`[feature-hints] ${message} ${JSON.stringify(fields)}`),
  });
  const loaded = store.load();

  function update(nextStateOf: (current: FeatureHintState) => FeatureHintState): Promise<void> {
    return loaded.then(() => {
      if (isStopped) return;
      const wasStarHintPending = core.isStarHintPending(state);
      const nextState = core.withoutStaleHint(nextStateOf(state), now(), isFeatureEnabled);
      const hint = core.decideHint(nextState, now(), isFeatureEnabled);
      state = hint ? { ...nextState, pendingHint: hint } : nextState;
      if (hint && areHintCardsEnabled()) broadcast({ type: 'feature-hint', hint });
      if (!wasStarHintPending && core.isStarHintPending(state) && areHintCardsEnabled()) broadcast({ type: 'star-hint' });
      const persistedState = state;
      return store.write(persistedState, () => `${JSON.stringify(persistedState, null, 2)}\n`);
    });
  }

  function recordSignals(signals: readonly FeatureSignal[]): Promise<void> {
    if (signals.length === 0) return Promise.resolve();
    return update((current) => core.recordSignals(current, signals, now(), isFeatureEnabled));
  }

  function attachSession(session: HintableSession): void {
    if (attachedSessions.has(session) || session.ephemeral) return;
    attachedSessions.add(session);
    function onHookEvent(notice: HookEventNotice): void {
      const classified = core.signalsFromHookEvent(notice, { sessionId: session.id, ts: now(), recentPrompts });
      recentPrompts = classified.recentPrompts;
      void recordSignals(classified.signals);
      if (core.isOperatorPromptEvent(notice)) void update(core.countStarHintPrompt);
    }
    function detach(): void {
      session.off('hook-event', onHookEvent);
      session.off('teardown', detach);
    }
    session.on('hook-event', onHookEvent);
    session.on('teardown', detach);
  }

  function noteViewShown(view: string): Promise<void> {
    return update((current) => core.noteViewShown(current, view, now()));
  }

  function settle(feature: HintFeature, outcome: HintOutcome): Promise<void> {
    return update((current) => core.settleHint(current, feature, outcome));
  }

  function settleStar(outcome: StarHintOutcome): Promise<void> {
    return update((current) => core.settleStarHint(current, outcome));
  }

  function pendingHintMessages(): (FeatureHintMessage | StarHintMessage)[] {
    if (!areHintCardsEnabled()) return [];
    const pendingHint = core.withoutStaleHint(state, now(), isFeatureEnabled).pendingHint;
    const featureHintMessages: FeatureHintMessage[] = pendingHint ? [{ type: 'feature-hint', hint: pendingHint }] : [];
    const starHintMessages: StarHintMessage[] = core.isStarHintPending(state) ? [{ type: 'star-hint' }] : [];
    return [...featureHintMessages, ...starHintMessages];
  }

  function idle(): Promise<void> {
    return loaded.then(() => store.idle());
  }

  async function stop(): Promise<void> {
    isStopped = true;
    await idle();
  }

  return { attachSession, noteViewShown, settle, settleStar, pendingHintMessages, stop, idle };
}

type FeatureHintsWiring = ReturnType<typeof createFeatureHintsWiring>;

export { createFeatureHintsWiring };
export type { FeatureHintsWiring };
