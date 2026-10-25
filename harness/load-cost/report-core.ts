import { z } from 'zod';
import { CHANNELS } from './shaping-core.ts';

const ChannelTallySchema = z.object({
  connections: z.number(),
  wireBytesDown: z.number(),
  wireBytesUp: z.number(),
  gzipBytesDown: z.number(),
  serverWaitMs: z.number(),
  serverTurns: z.number(),
});

const ScenarioResultSchema = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string(),
  runsMs: z.array(z.number()),
  medianMs: z.number(),
  channels: z.object({ http: ChannelTallySchema, control: ChannelTallySchema, data: ChannelTallySchema }),
  parsed: z.object({ controlJsonBytes: z.number(), replayBytes: z.number() }),
});

const ShellCheckSchema = z.object({
  proxyHttpBytes: z.number(),
  browserReportedHttpBytes: z.number(),
  assetFilesChecked: z.number(),
  assetMismatches: z.array(z.string()),
  isConsistent: z.boolean(),
});

export const LoadCostResultSchema = z.object({
  schemaVersion: z.literal(1),
  commit: z.string(),
  recordedAt: z.string(),
  profile: z.string(),
  viewport: z.string(),
  runs: z.number(),
  scenarios: z.array(ScenarioResultSchema),
  shellCheck: ShellCheckSchema.nullable(),
});

export type LoadCostResult = z.infer<typeof LoadCostResultSchema>;
export type ScenarioResult = z.infer<typeof ScenarioResultSchema>;
export type ShellCheck = z.infer<typeof ShellCheckSchema>;

const SHELL_CHECK_TOLERANCE = 0.02;

export function decideShellCheck(proxyHttpBytes: number, browserReportedHttpBytes: number, assetFilesChecked: number, assetMismatches: string[]): ShellCheck {
  const drift = Math.abs(proxyHttpBytes - browserReportedHttpBytes) / Math.max(proxyHttpBytes, 1);
  const isConsistent = drift <= SHELL_CHECK_TOLERANCE && assetMismatches.length === 0 && assetFilesChecked > 0;
  return { proxyHttpBytes, browserReportedHttpBytes, assetFilesChecked, assetMismatches, isConsistent };
}

function formatBytes(byteCount: number): string {
  if (byteCount < 1000) return `${Math.round(byteCount)} B`;
  if (byteCount < 1_000_000) return `${(byteCount / 1000).toFixed(1)} KB`;
  return `${(byteCount / 1_000_000).toFixed(2)} MB`;
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(2)} s`;
}

function formatFactor(before: number, after: number): string {
  if (after <= 0 || before <= 0) return 'n/a';
  return `${(before / after).toFixed(1)}x`;
}

function wireBytesDown(scenario: ScenarioResult): number {
  return CHANNELS.reduce((total, channel) => total + scenario.channels[channel].wireBytesDown, 0);
}

function parsedBytes(scenario: ScenarioResult): number {
  return scenario.parsed.controlJsonBytes + scenario.parsed.replayBytes;
}

function channelCell(scenario: ScenarioResult, channel: 'http' | 'control' | 'data'): string {
  const tally = scenario.channels[channel];
  return `${formatBytes(tally.wireBytesDown)} (${formatBytes(tally.gzipBytesDown)})`;
}

function serverWaitCell(scenario: ScenarioResult): string {
  return CHANNELS.map((channel) => `${channel} ${Math.round(scenario.channels[channel].serverWaitMs)} ms`).join(', ');
}

export function renderMarkdown(result: LoadCostResult): string {
  const lines = [
    `# Dashboard load cost`,
    '',
    `${result.profile}. ${result.viewport}. Median of ${result.runs} run(s). Commit ${result.commit.slice(0, 8)}, ${result.recordedAt}.`,
    'Wire bytes are server to browser, raw then gzip estimate in parentheses. Server wait is time from the last request byte reaching the server to its first response byte.',
    '',
    '| Scenario | Median | Runs | HTTP | Control WS | Data WS | Parsed control JSON | Parsed replay | Server wait | Connections |',
    '|---|---:|---|---:|---:|---:|---:|---:|---|---:|',
  ];
  for (const scenario of result.scenarios) {
    const connections = CHANNELS.reduce((total, channel) => total + scenario.channels[channel].connections, 0);
    lines.push(`| ${scenario.label} (${scenario.detail}) | ${formatSeconds(scenario.medianMs)} | ${scenario.runsMs.map(formatSeconds).join(', ')} | ${channelCell(scenario, 'http')} | ${channelCell(scenario, 'control')} | ${channelCell(scenario, 'data')} | ${formatBytes(scenario.parsed.controlJsonBytes)} | ${formatBytes(scenario.parsed.replayBytes)} | ${serverWaitCell(scenario)} | ${connections} |`);
  }
  if (result.shellCheck) {
    const check = result.shellCheck;
    lines.push('', `Shell check: proxy counted ${formatBytes(check.proxyHttpBytes)} of HTTP, the browser reported ${formatBytes(check.browserReportedHttpBytes)}; ${check.assetFilesChecked} dist/client files matched their size on disk${check.assetMismatches.length > 0 ? `, mismatches: ${check.assetMismatches.join(', ')}` : ''}. ${check.isConsistent ? 'Consistent.' : 'INCONSISTENT.'}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderComparison(before: LoadCostResult, after: LoadCostResult): string {
  const lines = [
    `# Load cost: ${before.commit.slice(0, 8)} (${before.recordedAt}) vs ${after.commit.slice(0, 8)} (${after.recordedAt})`,
    '',
    '| Scenario | Time was | Time now | Faster | Wire was | Wire now | Less | Parsed was | Parsed now | Less |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const scenario of after.scenarios) {
    const previous = before.scenarios.find((candidate) => candidate.id === scenario.id);
    if (!previous) {
      lines.push(`| ${scenario.label} | n/a | ${formatSeconds(scenario.medianMs)} | n/a | n/a | ${formatBytes(wireBytesDown(scenario))} | n/a | n/a | ${formatBytes(parsedBytes(scenario))} | n/a |`);
      continue;
    }
    lines.push(`| ${scenario.label} | ${formatSeconds(previous.medianMs)} | ${formatSeconds(scenario.medianMs)} | ${formatFactor(previous.medianMs, scenario.medianMs)} | ${formatBytes(wireBytesDown(previous))} | ${formatBytes(wireBytesDown(scenario))} | ${formatFactor(wireBytesDown(previous), wireBytesDown(scenario))} | ${formatBytes(parsedBytes(previous))} | ${formatBytes(parsedBytes(scenario))} | ${formatFactor(parsedBytes(previous), parsedBytes(scenario))} |`);
  }
  return `${lines.join('\n')}\n`;
}
