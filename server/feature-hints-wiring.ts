import type { EventEmitter } from 'node:events';
import { FeatureHintState } from '../shared/contracts/feature-hints.ts';
import type { FeatureHint, HintFeature, HintOutcome } from '../shared/contracts/feature-hints.ts';
import { createJsonStateStore } from './json-file.ts';
import * as core from './core/feature-hints-core.ts';
import type { FeatureSignal, HookEventNotice, RecentPrompt } from './core/feature-hints-core.ts';

interface FeatureHintsWiringOptions {
  statePath: string | null;
  broadcast: (message: { type: 'feature-hint'; hint: FeatureHint }) => void;
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
      const nextState = core.withoutStaleHint(nextStateOf(state), now(), isFeatureEnabled);
      const hint = core.decideHint(nextState, now(), isFeatureEnabled);
      state = hint ? { ...nextState, pendingHint: hint } : nextState;
      if (hint) broadcast({ type: 'feature-hint', hint });
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

  function pendingHintMessage(): { type: 'feature-hint'; hint: FeatureHint } | null {
    const pendingHint = core.withoutStaleHint(state, now(), isFeatureEnabled).pendingHint;
    return pendingHint ? { type: 'feature-hint', hint: pendingHint } : null;
  }

  function idle(): Promise<void> {
    return loaded.then(() => store.idle());
  }

  async function stop(): Promise<void> {
    isStopped = true;
    await idle();
  }

  return { attachSession, noteViewShown, settle, pendingHintMessage, stop, idle };
}

type FeatureHintsWiring = ReturnType<typeof createFeatureHintsWiring>;

export { createFeatureHintsWiring };
export type { FeatureHintsWiring };
