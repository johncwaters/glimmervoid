import { HINT_FEATURES, HINT_VIEW_BY_FEATURE } from '../../shared/contracts/feature-hints.ts';
import type { FeatureHint, FeatureHintState, HintFeature, HintOutcome } from '../../shared/contracts/feature-hints.ts';
import { isExperimentalSetting } from '../../shared/settings/registry.ts';
import { SETTINGS_INDEX } from '../../shared/settings/registry-core.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const SIGNAL_WINDOW_MS = 7 * DAY_MS;
const RECENT_VIEW_SKIP_MS = 14 * DAY_MS;
const REPEATED_PROMPT_WINDOW_MS = 60 * 60 * 1000;
const MIN_REPEATED_PROMPT_CHARS = 20;
const MAX_RECENT_PROMPTS = 20;
const MAX_SIGNALS_PER_FEATURE = 50;
const MAX_TARGET_CHARS = 200;

type SignalOrigin = 'agent-command' | 'agent-prompt';

interface FeatureSignal {
  feature: HintFeature;
  target: string;
  ts: number;
}

interface TriggerRule {
  feature: HintFeature;
  minDistinctTargets: number;
  countsEveryHit: boolean;
  matchCommand: (command: string) => string[];
  matchPrompt: (prompt: string) => string[];
}

interface RecentPrompt {
  normalizedPrompt: string;
  sessionId: string;
  ts: number;
}

const AGENT_NAMES = 'claude|codex|kimi|grok|gemini|cursor|copilot';

function firstNumberArgument(argumentText: string): string | null {
  const numberMatch = /(?:^|\s)(?:\S*\/(?:pull|issues)\/)?#?(\d+)\b/.exec(argumentText);
  return numberMatch?.[1] ?? null;
}

function ghSubcommandTargets(command: string, noun: 'pr' | 'issue', verbs: readonly string[], targetPrefix: string): string[] {
  const subcommandPattern = new RegExp(`\\bgh\\s+${noun}\\s+(${verbs.join('|')})\\b([^|;&\\n]*)`, 'g');
  return [...command.matchAll(subcommandPattern)].map((subcommandMatch) => {
    const targetNumber = firstNumberArgument(subcommandMatch[2] ?? '');
    return targetNumber ? `${targetPrefix}:${targetNumber}` : `${targetPrefix}:${subcommandMatch[1]}`;
  });
}

function numberedTargets(text: string, patterns: readonly RegExp[], targetPrefix: string): string[] {
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((textMatch) => `${targetPrefix}:${textMatch[1] ?? 'any'}`));
}

function hitWhenAnyMatches(text: string, patterns: readonly RegExp[]): string[] {
  return patterns.some((pattern) => pattern.test(text)) ? ['hit'] : [];
}

const REVIEW_PROMPT_PATTERNS = [
  /\/reviewing-prs\b(?:\s+\S*?#?(\d+)\b)?/gi,
  /\/code-review\b[^\n]*?\b(\d+)\b/gi,
  /\breview(?:ing)?\s+(?:the\s+|this\s+)?(?:pr|pull\s+request)\s*#?(\d+)?/gi,
  /github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/gi,
] as const;

const ISSUE_PROMPT_PATTERNS = [
  /\bissue\s+#(\d+)\b/gi,
  /github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/gi,
] as const;

const TRIGGER_RULES: readonly TriggerRule[] = [
  {
    feature: 'teamReview',
    minDistinctTargets: 3,
    countsEveryHit: false,
    matchCommand: (command) => ghSubcommandTargets(command, 'pr', ['review', 'diff', 'checkout', 'view'], 'pr').filter((target) => /\d$/.test(target)),
    matchPrompt: (prompt) => numberedTargets(prompt, REVIEW_PROMPT_PATTERNS, 'pr'),
  },
  {
    feature: 'issues',
    minDistinctTargets: 3,
    countsEveryHit: false,
    matchCommand: (command) => ghSubcommandTargets(command, 'issue', ['view', 'list', 'create', 'comment'], 'issue'),
    matchPrompt: (prompt) => numberedTargets(prompt, ISSUE_PROMPT_PATTERNS, 'issue'),
  },
  {
    feature: 'usage',
    minDistinctTargets: 2,
    countsEveryHit: true,
    matchCommand: (command) => hitWhenAnyMatches(command, [/\bccusage\b/]),
    matchPrompt: (prompt) => hitWhenAnyMatches(prompt, [/^\s*\/(?:cost|usage|stats)\b/i, /\btoken\s+usage\b/i, /\brate[\s-]limit/i, /\bspend(?:ing)?\b/i]),
  },
  {
    feature: 'posthog',
    minDistinctTargets: 2,
    countsEveryHit: true,
    matchCommand: () => [],
    matchPrompt: (prompt) => hitWhenAnyMatches(prompt, [/\berror\s+tracking\b/i, /\bwhat'?s\s+broken\b/i, /\/triaging-posthog-errors\b/i, /\bposthog\s+errors?\b/i]),
  },
  {
    feature: 'benchmarks',
    minDistinctTargets: 2,
    countsEveryHit: true,
    matchCommand: () => [],
    matchPrompt: (prompt) => hitWhenAnyMatches(prompt, [/\bbenchmark/i, new RegExp(`\\bcompare\\b[^\\n]*\\b(?:${AGENT_NAMES})\\b[^\\n]*\\b(?:${AGENT_NAMES})\\b`, 'i')]),
  },
];

const RULE_BY_FEATURE = new Map(TRIGGER_RULES.map((rule) => [rule.feature, rule]));

const EXPERIMENTAL_HINT_FEATURES: ReadonlySet<HintFeature> = new Set(HINT_FEATURES.filter((feature) => {
  const enableSetting = SETTINGS_INDEX.byPath.get(`${feature}.enabled`);
  return enableSetting !== undefined && isExperimentalSetting(enableSetting);
}));

function emptyFeatureHintState(): FeatureHintState {
  return { signalsByFeature: {}, settledByFeature: {}, lastShownAtByView: {}, pendingHint: null };
}

function fingerprintOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(16);
}

function signalsFromMatches(origin: SignalOrigin, text: string, ts: number, matchTargets: (rule: TriggerRule) => string[]): FeatureSignal[] {
  return TRIGGER_RULES.flatMap((rule) => {
    const matchedTargets = [...new Set(matchTargets(rule))];
    if (matchedTargets.length === 0) return [];
    if (rule.countsEveryHit) return [{ feature: rule.feature, target: `${origin}@${ts}:${fingerprintOf(text)}`, ts }];
    return matchedTargets.map((target) => ({ feature: rule.feature, target: target.slice(0, MAX_TARGET_CHARS), ts }));
  });
}

function classifyCommand(command: string, ts: number): FeatureSignal[] {
  if (!command.trim()) return [];
  return signalsFromMatches('agent-command', command, ts, (rule) => rule.matchCommand(command));
}

function classifyPrompt(prompt: string, ts: number): FeatureSignal[] {
  if (!prompt.trim()) return [];
  return signalsFromMatches('agent-prompt', prompt, ts, (rule) => rule.matchPrompt(prompt));
}

function normalizePrompt(prompt: string): string {
  return prompt.trim().toLowerCase().replace(/\s+/g, ' ');
}

function noteRecentPrompt(recentPrompts: readonly RecentPrompt[], { prompt, sessionId, ts }: { prompt: string; sessionId: string; ts: number }) {
  const normalizedPrompt = normalizePrompt(prompt);
  const freshPrompts = recentPrompts.filter((recentPrompt) => ts - recentPrompt.ts <= REPEATED_PROMPT_WINDOW_MS);
  if (normalizedPrompt.length < MIN_REPEATED_PROMPT_CHARS) return { recentPrompts: freshPrompts, signals: [] };
  const isRepeatedAcrossSessions = freshPrompts.some((recentPrompt) => recentPrompt.normalizedPrompt === normalizedPrompt && recentPrompt.sessionId !== sessionId);
  const nextPrompts = [...freshPrompts, { normalizedPrompt, sessionId, ts }].slice(-MAX_RECENT_PROMPTS);
  const signals: FeatureSignal[] = isRepeatedAcrossSessions ? [{ feature: 'benchmarks', target: `repeated-prompt@${ts}`, ts }] : [];
  return { recentPrompts: nextPrompts, signals };
}

interface HookEventNotice {
  event: string;
  payload: Record<string, unknown>;
}

interface HookEventContext {
  sessionId: string;
  ts: number;
  recentPrompts: readonly RecentPrompt[];
}

function bashCommandOf(payload: Record<string, unknown>): string | null {
  if (payload.tool_name !== 'Bash') return null;
  const toolInput = payload.tool_input;
  if (typeof toolInput !== 'object' || toolInput === null || !('command' in toolInput)) return null;
  return typeof toolInput.command === 'string' ? toolInput.command : null;
}

function signalsFromHookEvent({ event, payload }: HookEventNotice, { sessionId, ts, recentPrompts }: HookEventContext): { signals: FeatureSignal[]; recentPrompts: readonly RecentPrompt[] } {
  const unchanged = { signals: [], recentPrompts };
  const hookEvent = event.toLowerCase();
  if (hookEvent === 'posttooluse') {
    const command = bashCommandOf(payload);
    return command ? { signals: classifyCommand(command, ts), recentPrompts } : unchanged;
  }
  if (hookEvent !== 'userpromptsubmit' || typeof payload.prompt !== 'string') return unchanged;
  const repeated = noteRecentPrompt(recentPrompts, { prompt: payload.prompt, sessionId, ts });
  return { signals: [...classifyPrompt(payload.prompt, ts), ...repeated.signals], recentPrompts: repeated.recentPrompts };
}

function withoutStaleHint(state: FeatureHintState, now: number): FeatureHintState {
  if (!state.pendingHint) return state;
  const isExpired = now - state.pendingHint.raisedAt > SIGNAL_WINDOW_MS;
  if (!isExpired && !EXPERIMENTAL_HINT_FEATURES.has(state.pendingHint.feature)) return state;
  return { ...state, pendingHint: null };
}

function isFeatureCounting(state: FeatureHintState, feature: HintFeature): boolean {
  if (EXPERIMENTAL_HINT_FEATURES.has(feature)) return false;
  if (state.settledByFeature[feature]) return false;
  return state.pendingHint?.feature !== feature;
}

function recordSignals(state: FeatureHintState, signals: readonly FeatureSignal[], now: number): FeatureHintState {
  const countingSignals = signals.filter((signal) => isFeatureCounting(state, signal.feature));
  if (countingSignals.length === 0) return state;
  const signalsByFeature = { ...state.signalsByFeature };
  for (const signal of countingSignals) {
    const freshSignals = (signalsByFeature[signal.feature] ?? []).filter((recorded) => now - recorded.ts <= SIGNAL_WINDOW_MS && recorded.target !== signal.target);
    signalsByFeature[signal.feature] = [...freshSignals, { target: signal.target, ts: signal.ts }].slice(-MAX_SIGNALS_PER_FEATURE);
  }
  return { ...state, signalsByFeature };
}

function distinctTargetCountInWindow(state: FeatureHintState, feature: HintFeature, now: number): number {
  const recentTargets = (state.signalsByFeature[feature] ?? []).filter((recorded) => now - recorded.ts <= SIGNAL_WINDOW_MS).map((recorded) => recorded.target);
  return new Set(recentTargets).size;
}

function wasViewShownRecently(state: FeatureHintState, feature: HintFeature, now: number): boolean {
  const lastShownAt = state.lastShownAtByView[HINT_VIEW_BY_FEATURE[feature]];
  return typeof lastShownAt === 'number' && now - lastShownAt <= RECENT_VIEW_SKIP_MS;
}

function decideHint(state: FeatureHintState, now: number): FeatureHint | null {
  if (withoutStaleHint(state, now).pendingHint) return null;
  for (const feature of HINT_FEATURES) {
    if (!isFeatureCounting(state, feature) || wasViewShownRecently(state, feature, now)) continue;
    const distinctTargetCount = distinctTargetCountInWindow(state, feature, now);
    const minDistinctTargets = RULE_BY_FEATURE.get(feature)?.minDistinctTargets ?? Number.POSITIVE_INFINITY;
    if (distinctTargetCount >= minDistinctTargets) return { feature, distinctTargetCount, raisedAt: now };
  }
  return null;
}

function settleHint(state: FeatureHintState, feature: HintFeature, outcome: HintOutcome): FeatureHintState {
  if (state.settledByFeature[feature]) return state;
  const { [feature]: _settledSignals, ...signalsByFeature } = state.signalsByFeature;
  return {
    ...state,
    signalsByFeature,
    settledByFeature: { ...state.settledByFeature, [feature]: outcome },
    pendingHint: state.pendingHint?.feature === feature ? null : state.pendingHint,
  };
}

function noteViewShown(state: FeatureHintState, view: string, now: number): FeatureHintState {
  const viewedState = { ...state, lastShownAtByView: { ...state.lastShownAtByView, [view]: now } };
  const pendingFeature = state.pendingHint?.feature;
  if (!pendingFeature || HINT_VIEW_BY_FEATURE[pendingFeature] !== view) return viewedState;
  return settleHint(viewedState, pendingFeature, 'opened');
}

export {
  decideHint, emptyFeatureHintState, noteViewShown, recordSignals, settleHint, signalsFromHookEvent, withoutStaleHint,
};
export type { FeatureSignal, HookEventNotice, RecentPrompt };
