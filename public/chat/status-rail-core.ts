import type { ModelSelection } from '#shared/contracts/agent-models.ts';
import type { SessionMeterReading } from '#shared/contracts/control/lane-messages.ts';
import { formatTokens, formatUsd, planWindowOf } from '../usage/usage-store-core.ts';
import type { PlanLimits, PlanLimitsVendor } from '../usage/usage-store-core.ts';

export interface RunningSubagent {
  type: string;
  model: string | null;
}

export type RailField =
  | { kind: 'model'; name: string; effort: string | null }
  | { kind: 'plan'; label: '5h' | 'wk'; pct: number; resetsInMs: number | null }
  | { kind: 'context'; tokens: number; window: number }
  | { kind: 'callCost'; usd: number }
  | { kind: 'sessionCost'; usd: number }
  | { kind: 'subagents'; agents: readonly RunningSubagent[] }
  | { kind: 'mode'; name: string };

interface RailInput {
  meter: SessionMeterReading | null;
  selection: ModelSelection | null;
  planLimits: PlanLimits | null;
  sessionCostUSD: number | null;
  subagents: readonly RunningSubagent[];
  nowMs: number;
}

const DEFAULT_OUTPUT_STYLE = 'default';
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const PLAN_VENDOR_BY_AGENT: Readonly<Record<string, PlanLimitsVendor>> = { 'claude-code': 'claude', codex: 'codex', kimi: 'kimi' };

export function planVendorOfAgent(agent: string | null | undefined): PlanLimitsVendor | null {
  if (!agent) return null;
  return PLAN_VENDOR_BY_AGENT[agent] ?? null;
}

function modelFieldOf(meter: SessionMeterReading | null, selection: ModelSelection | null): RailField | null {
  const name = meter?.model ?? selection?.model ?? null;
  if (name === null) return null;
  return { kind: 'model', name, effort: meter?.effort ?? null };
}

function hasWindowReset(resetsAtMs: number | null, nowMs: number): boolean {
  return resetsAtMs !== null && resetsAtMs <= nowMs;
}

function tightestPlanFieldOf(planLimits: PlanLimits | null, nowMs: number): RailField | null {
  const windows = [
    { label: '5h' as const, window: planWindowOf(planLimits, 'fiveHour') },
    { label: 'wk' as const, window: planWindowOf(planLimits, 'sevenDay') },
  ].flatMap(({ label, window }) => (window?.pct == null || hasWindowReset(window.resetsAtMs, nowMs) ? [] : [{ label, pct: window.pct, resetsAtMs: window.resetsAtMs }]));
  const tightest = windows.reduce<(typeof windows)[number] | null>((tightestSoFar, candidate) => (tightestSoFar === null || candidate.pct > tightestSoFar.pct ? candidate : tightestSoFar), null);
  if (tightest === null) return null;
  const resetsInMs = tightest.resetsAtMs === null ? null : tightest.resetsAtMs - nowMs;
  return { kind: 'plan', label: tightest.label, pct: tightest.pct, resetsInMs };
}

function contextFieldOf(meter: SessionMeterReading | null): RailField | null {
  if (meter?.contextTokens == null || meter.contextWindow == null) return null;
  return { kind: 'context', tokens: meter.contextTokens, window: meter.contextWindow };
}

function costFieldsOf(meter: SessionMeterReading | null, sessionCostUSD: number | null): RailField[] {
  const fields: RailField[] = [];
  if (meter?.callCostUSD != null) fields.push({ kind: 'callCost', usd: meter.callCostUSD });
  if (sessionCostUSD !== null) fields.push({ kind: 'sessionCost', usd: sessionCostUSD });
  return fields;
}

function modeFieldOf(meter: SessionMeterReading | null): RailField | null {
  const outputStyle = meter?.outputStyle ?? null;
  if (outputStyle === null || outputStyle.toLowerCase() === DEFAULT_OUTPUT_STYLE) return null;
  return { kind: 'mode', name: outputStyle };
}

export function railFieldsOf({ meter, selection, planLimits, sessionCostUSD, subagents, nowMs }: RailInput): RailField[] {
  const workFields: RailField[] = subagents.length > 0 ? [{ kind: 'subagents', agents: subagents }] : costFieldsOf(meter, sessionCostUSD);
  const fields = [modelFieldOf(meter, selection), tightestPlanFieldOf(planLimits, nowMs), contextFieldOf(meter), ...workFields, modeFieldOf(meter)];
  return fields.filter((field): field is RailField => field !== null);
}

export function countdownText(remainingMs: number): string {
  if (remainingMs >= DAY_MS) return `${Math.floor(remainingMs / DAY_MS)}d${Math.floor((remainingMs % DAY_MS) / HOUR_MS)}h`;
  if (remainingMs >= HOUR_MS) return `${Math.floor(remainingMs / HOUR_MS)}h${Math.floor((remainingMs % HOUR_MS) / MINUTE_MS)}m`;
  return `${Math.max(1, Math.ceil(remainingMs / MINUTE_MS))}m`;
}

function subagentText({ type, model }: RunningSubagent): string {
  if (model === null) return type;
  return `${type} (${model})`;
}

const RAIL_TEXT_BY_KIND: { [Kind in RailField['kind']]: (field: Extract<RailField, { kind: Kind }>) => string } = {
  model: ({ name, effort }) => (effort === null ? name : `${name} ${effort}`),
  plan: ({ label, pct, resetsInMs }) => (resetsInMs === null ? `${label} ${Math.round(pct)}%` : `${label} ${Math.round(pct)}% ${countdownText(resetsInMs)}`),
  context: ({ tokens, window }) => `ctx ${formatTokens(tokens)}/${formatTokens(window)}`,
  callCost: ({ usd }) => `~${formatUsd(usd)}/call`,
  sessionCost: ({ usd }) => `session ${formatUsd(usd)}`,
  subagents: ({ agents }) => `${agents.length} ${agents.length === 1 ? 'subagent' : 'subagents'}: ${agents.map(subagentText).join(', ')}`,
  mode: ({ name }) => name,
};

export function railTextOf<Kind extends RailField['kind']>(field: Extract<RailField, { kind: Kind }>): string {
  const textOf = RAIL_TEXT_BY_KIND[field.kind] as (field: Extract<RailField, { kind: Kind }>) => string;
  return textOf(field);
}

export function railFillPctOf(field: RailField): number | null {
  if (field.kind === 'plan') return Math.min(100, Math.max(0, field.pct));
  if (field.kind === 'context') return Math.min(100, Math.max(0, (field.tokens / field.window) * 100));
  return null;
}
