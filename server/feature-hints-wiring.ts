import { FeatureHintState } from '../shared/contracts/feature-hints.ts';
import type { FeatureHint, HintFeature, HintOutcome } from '../shared/contracts/feature-hints.ts';
import { createJsonStateStore } from './json-file.ts';
import { createAgentLogIngest } from './ingest/ingest-agent-logs.ts';
import type { AgentLogIngestOptions } from './ingest/ingest-agent-logs.ts';
import type { AgentIngestEvent } from './ingest/core/ingest-agent-core.ts';
import { createShellHistoryIngest } from './ingest/ingest-shell-history.ts';
import type { ShellHistoryOptions } from './ingest/ingest-shell-history.ts';
import type { ShellIngestEvent } from './ingest/core/ingest-shell-core.ts';
import * as core from './core/feature-hints-core.ts';
import type { FeatureSignal, RecentPrompt } from './core/feature-hints-core.ts';

interface FeatureHintsWiringOptions {
  statePath: string | null;
  broadcast: (message: { type: 'feature-hint'; hint: FeatureHint }) => void;
  log: Pick<Console, 'warn'>;
  now?: () => number;
  shellHistory?: Omit<ShellHistoryOptions, 'publish'> | null;
  agentLogs?: Omit<AgentLogIngestOptions, 'publish'> | null;
}

const SHELL_TOOLS = new Set(['Bash', 'exec_command', 'shell']);
const HINTED_VENDORS = { claude: true, codex: true, kimi: true, grok: false };

function textAfterPrefix(text: string, prefix: string): string | null {
  return text.startsWith(prefix) ? text.slice(prefix.length) : null;
}

function toolCommandOf(event: AgentIngestEvent): string | null {
  if (event.kind !== 'agent-tool' || !SHELL_TOOLS.has(String(event.detail.tool))) return null;
  return textAfterPrefix(event.summary, `${event.detail.vendor}: ${event.detail.tool} `);
}

function promptOf(event: AgentIngestEvent): string | null {
  if (event.kind !== 'agent-prompt') return null;
  return textAfterPrefix(event.summary, `${event.detail.vendor}: `);
}

function shellCommandOf(event: ShellIngestEvent): string | null {
  if (event.kind !== 'command') return null;
  return textAfterPrefix(event.summary, `${event.detail.shell}: `);
}

function createFeatureHintsWiring({ statePath, broadcast, log, now = Date.now, shellHistory = {}, agentLogs = {} }: FeatureHintsWiringOptions) {
  let state = core.emptyFeatureHintState();
  let recentPrompts: readonly RecentPrompt[] = [];
  let isStopped = false;
  const store = createJsonStateStore({
    name: 'feature hints', filePath: statePath,
    parse: (raw) => FeatureHintState.safeParse(raw).data ?? null,
    adopt: (loadedState) => { state = loadedState ?? core.emptyFeatureHintState(); },
    warn: (message, fields) => log.warn(`[feature-hints] ${message} ${JSON.stringify(fields)}`),
  });
  const loaded = store.load();

  function update(nextStateOf: (current: FeatureHintState) => FeatureHintState): Promise<void> {
    return loaded.then(() => {
      if (isStopped) return;
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

  function signalsFromAgentEvent(event: AgentIngestEvent): FeatureSignal[] {
    const command = toolCommandOf(event);
    if (command) return core.classifyCommand(command, 'agent-command', event.ts);
    const prompt = promptOf(event);
    if (!prompt) return [];
    const repeated = core.noteRecentPrompt(recentPrompts, { prompt, sessionId: event.scope.sessionId ?? '', ts: event.ts });
    recentPrompts = repeated.recentPrompts;
    return [...core.classifyPrompt(prompt, event.ts), ...repeated.signals];
  }

  const shellHistoryIngest = shellHistory && createShellHistoryIngest({
    logger: log,
    ...shellHistory,
    publish: (event) => {
      const command = shellCommandOf(event);
      if (command) void recordSignals(core.classifyCommand(command, 'shell', event.ts));
    },
  });
  void shellHistoryIngest?.start();

  const agentLogIngest = agentLogs && createAgentLogIngest({
    logger: log,
    vendors: HINTED_VENDORS,
    readsFilesBornAfterStart: true,
    ...agentLogs,
    publish: (event) => { void recordSignals(signalsFromAgentEvent(event)); },
  });
  void agentLogIngest?.start();

  function noteViewShown(view: string): Promise<void> {
    return update((current) => core.noteViewShown(current, view, now()));
  }

  function settle(feature: HintFeature, outcome: HintOutcome): Promise<void> {
    return update((current) => core.settleHint(current, feature, outcome));
  }

  function pendingHintMessage(): { type: 'feature-hint'; hint: FeatureHint } | null {
    return state.pendingHint ? { type: 'feature-hint', hint: state.pendingHint } : null;
  }

  function idle(): Promise<void> {
    return loaded.then(() => store.idle());
  }

  async function stop(): Promise<void> {
    await Promise.all([shellHistoryIngest?.stop(), agentLogIngest?.stop()]);
    isStopped = true;
    await idle();
  }

  return { noteViewShown, settle, pendingHintMessage, stop, idle };
}

type FeatureHintsWiring = ReturnType<typeof createFeatureHintsWiring>;

export { createFeatureHintsWiring };
export type { FeatureHintsWiring };
