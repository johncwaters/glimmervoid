import { z } from 'zod';

import { GITHUB_USAGE_RESOURCES } from '../../../shared/contracts/github-usage.ts';
import type { GithubOperationUsage, GithubResourceUsage, GithubUsageResource, GithubUsageSnapshot } from '../../../shared/contracts/github-usage.ts';
import { parseJsonOrNull } from '../../core/json-core.ts';
import { GITHUB_RATE_LIMIT_WINDOW_MS } from './github-rate-limit-core.ts';
import type { GithubRateLimitResources } from './github-rate-limit-core.ts';

export const GITHUB_USAGE_WINDOW_MS = GITHUB_RATE_LIMIT_WINDOW_MS;
export const UNATTRIBUTED_OPERATION = 'unattributed';

export type GithubCall = { atMs: number; operation: string; resource: GithubUsageResource; points: number; isOk: boolean };
export type GithubUsageRecorder = { record(call: Omit<GithubCall, 'atMs'>): void };

const GITHUB_SEARCH_WINDOW_MS = 60_000;
const RESOURCE_WINDOW_MS: Readonly<Record<GithubUsageResource, number>> = { graphql: GITHUB_RATE_LIMIT_WINDOW_MS, core: GITHUB_RATE_LIMIT_WINDOW_MS, search: GITHUB_SEARCH_WINDOW_MS };
const GITHUB_DEFAULT_PAGE_SIZE = 30;
const NOT_MODIFIED_STATUS_LINE = /^HTTP\/\d+(?:\.\d+)?\s+304(?:\s|$)/;
const QUERY_OPERATION_OPENING = /^\s*query\b[^{]*\{/;
const RateLimitCostResponse = z.object({ data: z.object({ rateLimit: z.object({ cost: z.number().nonnegative() }) }) });

export function withRateLimitCost(query: string): string {
  return query.replace(QUERY_OPERATION_OPENING, (opening) => `${opening} rateLimit { cost }`);
}

function rateLimitCostOf(stdout: string): number | null {
  const parsed = RateLimitCostResponse.safeParse(parseJsonOrNull(stdout));
  return parsed.success ? parsed.data.data.rateLimit.cost : null;
}

export function isNotModifiedResponse(stdout: string): boolean {
  return NOT_MODIFIED_STATUS_LINE.test(stdout);
}

function paginatedPagesOf(stdout: string): number {
  const itemCount = stdout.split('\n').filter((line) => line.trim() !== '').length;
  return Math.max(1, Math.ceil(itemCount / GITHUB_DEFAULT_PAGE_SIZE));
}

export function githubCallPoints(ghArgs: readonly string[], resource: GithubUsageResource, stdout: string): number {
  if (isNotModifiedResponse(stdout)) return 0;
  if (resource === 'graphql') return rateLimitCostOf(stdout) ?? 1;
  if (ghArgs.includes('--paginate')) return paginatedPagesOf(stdout);
  return 1;
}

const SUBCOMMAND_RESOURCES: Readonly<Record<string, readonly GithubUsageResource[]>> = {
  'pr diff': ['graphql', 'core'],
};

export function githubCallResources(ghArgs: readonly string[]): readonly GithubUsageResource[] {
  if (ghArgs[0] !== 'api') return SUBCOMMAND_RESOURCES[ghArgs.slice(0, 2).join(' ')] ?? ['graphql'];
  if (ghArgs.includes('rate_limit')) return [];
  if (ghArgs.includes('graphql')) return ['graphql'];
  if (ghArgs.some((arg) => arg.startsWith('search/'))) return ['search'];
  return ['core'];
}

export function callsWithinWindow(calls: readonly GithubCall[], nowMs: number): GithubCall[] {
  const windowStartMs = nowMs - GITHUB_USAGE_WINDOW_MS;
  return calls.filter((call) => call.atMs > windowStartMs);
}

function operationUsages(calls: readonly GithubCall[]): GithubOperationUsage[] {
  const usageByKey = new Map<string, GithubOperationUsage>();
  for (const call of calls) {
    const key = `${call.resource}\u0000${call.operation}`;
    const usage = usageByKey.get(key) ?? { operation: call.operation, resource: call.resource, calls: 0, points: 0, failures: 0 };
    usage.calls += 1;
    usage.points += call.points;
    if (!call.isOk) usage.failures += 1;
    usageByKey.set(key, usage);
  }
  return [...usageByKey.values()].sort((left, right) => right.points - left.points || right.calls - left.calls);
}

function resourceUsage(resource: GithubUsageResource, calls: readonly GithubCall[], account: GithubRateLimitResources | null, nowMs: number): GithubResourceUsage {
  const accountResource = account?.[resource];
  const resetAtMs = accountResource ? accountResource.reset * 1000 : null;
  const windowStartMs = (resetAtMs ?? nowMs) - RESOURCE_WINDOW_MS[resource];
  const glimmervoidPoints = calls
    .filter((call) => call.resource === resource && call.atMs >= windowStartMs)
    .reduce((total, call) => total + call.points, 0);
  return {
    resource,
    glimmervoidPoints,
    windowStartMs,
    accountUsed: accountResource?.used ?? null,
    accountLimit: accountResource?.limit ?? null,
    resetAtMs,
  };
}

export function summarizeGithubUsage(calls: readonly GithubCall[], account: GithubRateLimitResources | null, nowMs: number, recordingSinceMs: number): GithubUsageSnapshot {
  const recentCalls = callsWithinWindow(calls, nowMs);
  return {
    writtenAtMs: nowMs,
    windowMs: GITHUB_USAGE_WINDOW_MS,
    recordingSinceMs,
    operations: operationUsages(recentCalls),
    resources: GITHUB_USAGE_RESOURCES.map((resource) => resourceUsage(resource, recentCalls, account, nowMs)),
  };
}

function minutesBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.round((toMs - fromMs) / 60_000));
}

function accountShareText(usage: GithubResourceUsage): string {
  if (usage.accountUsed === null || usage.accountLimit === null) return `${usage.glimmervoidPoints} points by Glimmervoid; account pool unknown`;
  const share = usage.accountUsed > 0 ? Math.round((usage.glimmervoidPoints / usage.accountUsed) * 100) : 0;
  return `${usage.glimmervoidPoints} of ${usage.accountUsed} used by Glimmervoid (${share}%), account limit ${usage.accountLimit}`;
}

function resourceLine(usage: GithubResourceUsage, nowMs: number): string {
  const resetText = usage.resetAtMs === null ? '' : `, resets in ${minutesBetween(nowMs, usage.resetAtMs)} min`;
  return `  ${usage.resource.padEnd(8)} ${accountShareText(usage)}${resetText}`;
}

function operationLine(usage: GithubOperationUsage): string {
  const failuresText = usage.failures > 0 ? `  (${usage.failures} failed)` : '';
  return `  ${usage.resource.padEnd(8)} ${usage.operation.padEnd(26)} ${String(usage.calls).padStart(6)} ${String(usage.points).padStart(7)}${failuresText}`;
}

function recordingGapLines(snapshot: GithubUsageSnapshot, nowMs: number): string[] {
  const earliestWindowStartMs = Math.min(...snapshot.resources.map((usage) => usage.windowStartMs));
  if (snapshot.recordingSinceMs <= earliestWindowStartMs) return [];
  return [`  Glimmervoid started counting ${minutesBetween(snapshot.recordingSinceMs, nowMs)} min ago, so calls before its last start are missing from its share.`];
}

export function formatGithubUsage(snapshot: GithubUsageSnapshot, nowMs: number): string {
  const lines = [
    `GitHub usage snapshot written ${minutesBetween(snapshot.writtenAtMs, nowMs)} min ago`,
    '',
    'Account pool in GitHub\'s current window:',
    ...snapshot.resources.map((usage) => resourceLine(usage, nowMs)),
    ...recordingGapLines(snapshot, nowMs),
    '',
    `Glimmervoid calls in the last ${Math.round(snapshot.windowMs / 60_000)} min:`,
    `  ${'resource'.padEnd(8)} ${'operation'.padEnd(26)} ${'calls'.padStart(6)} ${'points'.padStart(7)}`,
  ];
  if (snapshot.operations.length === 0) return [...lines, '  none'].join('\n');
  return [...lines, ...snapshot.operations.map(operationLine)].join('\n');
}

export function githubUsageLogLine(snapshot: GithubUsageSnapshot, maxOperations: number): string {
  const resourcesText = snapshot.resources.map((usage) => `${usage.resource} ${accountShareText(usage)}`).join('; ');
  const topOperationsText = snapshot.operations.slice(0, maxOperations).map((usage) => `${usage.operation} ${usage.calls}x/${usage.points}pt`).join(', ');
  return `[github-usage] ${resourcesText}; top: ${topOperationsText || 'none'}`;
}
