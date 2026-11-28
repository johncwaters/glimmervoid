import type { PermissionMode } from '#shared/contracts/trace.ts';

export type SessionPermissionMode = { mode: PermissionMode; modeName: string };
import type { ModelSelection } from '#shared/contracts/agent-models.ts';
import type { SessionMeterReading } from '#shared/contracts/control/lane-messages.ts';
import { formatTokens, formatUsd, planLimitsForModel, planWindowOf } from '../usage/usage-store-core.ts';
import { agentLabel } from '../arena/lineup-core.ts';
import type { PlanLimits, PlanLimitsVendor } from '../usage/usage-store-core.ts';

export type RailField =
  | { kind: 'model'; name: string; effort: string | null; canChange: boolean; agent: string | null }
  | { kind: 'plan'; label: '5h' | 'wk'; pct: number; resetsInMs: number | null }
  | { kind: 'context'; tokens: number; window: number }
  | { kind: 'callCost'; usd: number }
  | { kind: 'sessionCost'; usd: number }
  | { kind: 'mode'; name: string }
  | { kind: 'permission'; mode: string };

interface RailInput {
  meter: SessionMeterReading | null;
  selection: ModelSelection | null;
  planLimits: PlanLimits | null;
  sessionCostUSD: number | null;
  nowMs: number;
  canChangeModel?: boolean;
  agent?: string | null;
  permissionMode?: SessionPermissionMode | null;
}

const DEFAULT_OUTPUT_STYLE = 'default';
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const PLAN_VENDOR_BY_AGENT: Readonly<Record<string, PlanLimitsVendor>> = { 'claude-code': 'claude', codex: 'codex', kimi: 'kimi', antigravity: 'antigravity' };

export function planVendorOfAgent(agent: string | null | undefined): PlanLimitsVendor | null {
  if (!agent) return null;
  return PLAN_VENDOR_BY_AGENT[agent] ?? null;
}

function modelFieldOf(meter: SessionMeterReading | null, selection: ModelSelection | null, canChange: boolean, agent: string | null): RailField | null {
  const name = meter?.model ?? selection?.model ?? (agent === null ? null : agentLabel(agent));
  if (name === null) return null;
  return { kind: 'model', name, effort: meter?.effort ?? null, canChange, agent };
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

const DEFAULT_PERMISSION_MODE = 'default';
const PERMISSION_MODE_TEXT_BY_MODE: Readonly<Record<PermissionMode, string>> = { default: 'default', acceptEdits: 'accept edits', bypassPermissions: 'bypass permissions', plan: 'plan mode', dontAsk: "don't ask", auto: 'auto mode', other: 'other mode' };

function permissionFieldOf(permissionMode: SessionPermissionMode | null): RailField | null {
  if (permissionMode === null || permissionMode.mode === DEFAULT_PERMISSION_MODE) return null;
  return { kind: 'permission', mode: permissionMode.mode === 'other' ? permissionMode.modeName : PERMISSION_MODE_TEXT_BY_MODE[permissionMode.mode] };
}

export function railFieldsOf({ meter, selection, planLimits, sessionCostUSD, nowMs, canChangeModel = false, agent = null, permissionMode = null }: RailInput): RailField[] {
  const activeModel = meter?.model ?? selection?.model ?? null;
  const scopedPlanLimits = planLimitsForModel(planLimits, activeModel, agent);
  const fields = [modelFieldOf(meter, selection, canChangeModel, agent), tightestPlanFieldOf(scopedPlanLimits, nowMs), contextFieldOf(meter), ...costFieldsOf(meter, sessionCostUSD), modeFieldOf(meter), permissionFieldOf(permissionMode)];
  return fields.filter((field): field is RailField => field !== null);
}

function countdownText(remainingMs: number): string {
  if (remainingMs >= DAY_MS) return `${Math.floor(remainingMs / DAY_MS)}d${Math.floor((remainingMs % DAY_MS) / HOUR_MS)}h`;
  if (remainingMs >= HOUR_MS) return `${Math.floor(remainingMs / HOUR_MS)}h${Math.floor((remainingMs % HOUR_MS) / MINUTE_MS)}m`;
  return `${Math.max(1, Math.ceil(remainingMs / MINUTE_MS))}m`;
}

function hasEffortInModelName(name: string, effort: string): boolean {
  return name.trimEnd().toLowerCase().endsWith(`(${effort.toLowerCase()})`);
}

function modelTextOf(name: string, effort: string | null): string {
  const trimmedEffort = effort?.trim() ?? '';
  if (trimmedEffort === '' || hasEffortInModelName(name, trimmedEffort)) return name;
  return `${name} ${trimmedEffort}`;
}

const RAIL_TEXT_BY_KIND: { [Kind in RailField['kind']]: (field: Extract<RailField, { kind: Kind }>) => string } = {
  model: ({ name, effort }) => modelTextOf(name, effort),
  plan: ({ label, pct, resetsInMs }) => (resetsInMs === null ? `${label} ${Math.round(pct)}%` : `${label} ${Math.round(pct)}% ${countdownText(resetsInMs)}`),
  context: ({ tokens, window }) => `ctx ${formatTokens(tokens)}/${formatTokens(window)}`,
  callCost: ({ usd }) => `~${formatUsd(usd)}/call`,
  sessionCost: ({ usd }) => `session ${formatUsd(usd)}`,
  mode: ({ name }) => name,
  permission: ({ mode }) => mode,
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

type RailLevel = 'ok' | 'warn' | 'hot';
type RailGroup = 'limits' | 'work';

const RAIL_WARN_PCT = 50;
const RAIL_HOT_PCT = 80;
const RAIL_GROUP_ORDER: readonly RailGroup[] = ['limits', 'work'];

const RAIL_GROUP_BY_KIND: Readonly<Record<Exclude<RailField['kind'], 'model'>, RailGroup>> = {
  plan: 'limits',
  context: 'limits',
  callCost: 'work',
  sessionCost: 'work',
  mode: 'work',
  permission: 'work',
};

interface RailModelDisplay {
  readonly isShown: boolean;
  readonly agent: string | null;
  readonly text: string;
  readonly ariaLabel: string;
  readonly canChange: boolean;
}

interface RailReadingFieldDisplay {
  readonly kind: Exclude<RailField['kind'], 'model'>;
  readonly text: string;
  readonly fillPct: number | null;
  readonly level: RailLevel | null;
}

interface RailGroupSection {
  readonly group: RailGroup;
  readonly fields: readonly RailReadingFieldDisplay[];
}

export function railLevelOf(fillPct: number): RailLevel {
  const shownPct = Math.round(fillPct);
  if (shownPct >= RAIL_HOT_PCT) return 'hot';
  if (shownPct >= RAIL_WARN_PCT) return 'warn';
  return 'ok';
}

export function railModelDisplayOf(fields: readonly RailField[]): RailModelDisplay {
  const modelField = fields.find((field) => field.kind === 'model');
  if (modelField?.kind !== 'model') {
    return { isShown: false, agent: null, text: '', ariaLabel: '', canChange: false };
  }
  const text = railTextOf(modelField);
  return {
    isShown: true,
    agent: modelField.agent,
    text,
    ariaLabel: `Change model, ${text}`,
    canChange: modelField.canChange,
  };
}

export function railGroupsOf(fields: readonly RailField[]): RailGroupSection[] {
  return RAIL_GROUP_ORDER.flatMap((group) => {
    const groupFields = fields.flatMap((field): RailReadingFieldDisplay[] => {
      if (field.kind === 'model' || RAIL_GROUP_BY_KIND[field.kind] !== group) return [];
      const fillPct = railFillPctOf(field);
      return [{
        kind: field.kind,
        text: railTextOf(field),
        fillPct,
        level: fillPct === null ? null : railLevelOf(fillPct),
      }];
    });
    if (groupFields.length === 0) return [];
    return [{ group, fields: groupFields }];
  });
}
