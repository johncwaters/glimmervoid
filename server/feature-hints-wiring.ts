import { FeatureHintState } from '../shared/contracts/feature-hints.ts';
import type { FeatureHint, HintFeature, HintOutcome } from '../shared/contracts/feature-hints.ts';
import { createJsonStateStore } from './json-file.ts';
import * as core from './core/feature-hints-core.ts';
import type { FeatureSignal, RecentPrompt } from './core/feature-hints-core.ts';

interface HookEventNotice {
  event: string;
  payload: Record<string, unknown>;
}

interface HintableSession {
  id: string;
  on(event: 'hook-event', listener: (notice: HookEventNotice) => void): unknown;
  on(event: 'teardown', listener: () => void): unknown;
  off(event: 'hook-event', listener: (notice: HookEventNotice) => void): unknown;
  off(event: 'teardown', listener: () => void): unknown;
}

interface FeatureHintsWiringOptions {
  statePath: string | null;
  broadcast: (message: { type: 'feature-hint'; hint: FeatureHint }) => void;
  log: Pick<Console, 'warn'>;
  now?: () => number;
}

function bashCommandOf(payload: Record<string, unknown>): string | null {
  if (payload.tool_name !== 'Bash') return null;
  const toolInput = payload.tool_input;
  if (typeof toolInput !== 'object' || toolInput === null || !('command' in toolInput)) return null;
  return typeof toolInput.command === 'string' ? toolInput.command : null;
}

function createFeatureHintsWiring({ statePath, broadcast, log, now = Date.now }: FeatureHintsWiringOptions) {
  let state = core.emptyFeatureHintState();
  let recentPrompts: readonly RecentPrompt[] = [];
  const attachedSessions = new WeakSet<HintableSession>();
  const store = createJsonStateStore({
    name: 'feature hints', filePath: statePath,
    parse: (raw) => FeatureHintState.safeParse(raw).data ?? null,
    adopt: (loadedState) => { state = loadedState ?? core.emptyFeatureHintState(); },
    warn: (message, fields) => log.warn(`[feature-hints] ${message} ${JSON.stringify(fields)}`),
  });
  const loaded = store.load();

  function update(nextStateOf: (current: FeatureHintState) => FeatureHintState): Promise<void> {
    return loaded.then(() => {
      const nextState = core.withoutExpiredHint(nextStateOf(state), now());
      const hint = core.decideHint(nextState, now());
      state = hint ? { ...nextState, pendingHint: hint } : nextState;
      if (hint) broadcast({ type: 'feature-hint', hint });
      const persistedState = state;
      return store.write(persistedState, () => `${JSON.stringify(persistedState, null, 2)}\n`);
    });
  }

  function recordSignals(signals: readonly FeatureSignal[]): Promise<void> {
    if (signals.length === 0) return Promise.resolve();
    return update((current) => core.recordSignals(current, signals, now()));
  }

  function signalsFromHookEvent(session: HintableSession, { event, payload }: HookEventNotice): FeatureSignal[] {
    const ts = now();
    if (event === 'PostToolUse') {
      const command = bashCommandOf(payload);
      return command ? core.classifyCommand(command, 'agent-command', ts) : [];
    }
    if (event !== 'UserPromptSubmit' || typeof payload.prompt !== 'string') return [];
    const repeated = core.noteRecentPrompt(recentPrompts, { prompt: payload.prompt, sessionId: session.id, ts });
    recentPrompts = repeated.recentPrompts;
    return [...core.classifyPrompt(payload.prompt, ts), ...repeated.signals];
  }

  function attachSession(session: HintableSession): void {
    if (attachedSessions.has(session)) return;
    attachedSessions.add(session);
    function onHookEvent(notice: HookEventNotice): void {
      void recordSignals(signalsFromHookEvent(session, notice));
    }
    function detach(): void {
      attachedSessions.delete(session);
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
    return state.pendingHint ? { type: 'feature-hint', hint: state.pendingHint } : null;
  }

  return { attachSession, noteViewShown, settle, pendingHintMessage, idle: () => loaded.then(() => store.idle()) };
}

type FeatureHintsWiring = ReturnType<typeof createFeatureHintsWiring>;

export { createFeatureHintsWiring };
export type { FeatureHintsWiring, HintableSession };
