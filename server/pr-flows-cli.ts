import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PR_ACTION_REPORT_URL_ENV, PR_ACTION_TOKEN_ENV, PrActionReportBody, PrFlowsState } from '../shared/contracts/pr-flows.ts';
import { AGENT_URL_ENV, AgentSettingsReply } from '../shared/contracts/session.ts';
import type { PackOnDisk } from '../shared/contracts/pack.ts';
import type { PrFlowCommand, PrFlowPrAction, PrFlowSourceOutput } from '../shared/contracts/pr-flows.ts';
import { errorMessage } from '../shared/text.ts';
import { runCommandSafely } from './child-process-safe.ts';
import type { CommandRunOptions, CommandRunResult } from './child-process-safe.ts';
import type { ParsedCommand } from './core/cli-spec-core.ts';
import { decideConfigPath, glimmervoidHomeDir } from './core/config-path-core.ts';
import { parseJsonOrNull } from './core/json-core.ts';
import { commandFingerprint, expandPlaceholders, packPathsOf, prFlowSetup, prFlowsConfig, scopedToRepo, unknownPlaceholderMessage } from './github/core/pr-flows-core.ts';
import { PR_FLOW_PLACEHOLDERS_BY_KIND } from '../shared/contracts/pr-flows.ts';
import { packDirsUnder, readApprovedPackFingerprints, readPackDir } from './packs/pack-files.ts';
import { createPrFlowsExternal } from './github/pr-flows-external.ts';

const PR_URL_PATTERN = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)\/?$/;
const GH_TIMEOUT_MS = 30_000;
const GH_OUTPUT_MAX_BYTES = 64 * 1024;
const REPORT_TIMEOUT_MS = 15_000;

type CommandRunner = (command: string, args: string[], options: CommandRunOptions) => Promise<CommandRunResult>;
type ConfigReading = { configPath: string; configFile: unknown };
const SERVER_SETTING_PATHS = ['prFlows.sources', 'prFlows.actions', 'prFlows.prActions', 'prFlows.rules', 'prFlows.repoRules', 'packs'] as const;
type CheckedPr = { url: string; repo: string; number: number; headRefOid: string };
type EntryCheck = { kind: keyof typeof PR_FLOW_PLACEHOLDERS_BY_KIND; id: string; label: string; isApproved: boolean; error: string | null; argv: string[] | null };
type SourceCheck = { id: string; label: string; output: PrFlowSourceOutput | null; error: string | null };
type OutOfScopeSource = { id: string; label: string; repos: string[] };
type PrFlowsCheckReport = { configPath: string; warnings: string[]; entries: EntryCheck[]; pr: CheckedPr | null; sourceRuns: SourceCheck[]; outOfScopeSources: OutOfScopeSource[] };

interface PrFlowsCheckIo {
  writeOutput: (text: string) => void;
  writeError: (text: string) => void;
}

interface PrFlowsCheckOptions {
  prUrl: string | null;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  runCommand: CommandRunner;
  readConfig: () => Promise<ConfigReading>;
}

function placeholderSample(names: readonly string[], pr: CheckedPr | null): Record<string, string> {
  const prValues: Record<string, string> = pr ? { prUrl: pr.url, repo: pr.repo, number: String(pr.number), head: pr.headRefOid } : {};
  return Object.fromEntries(names.map((name) => [name, prValues[name] ?? `{${name}}`]));
}

function entryCheck(kind: EntryCheck['kind'], command: PrFlowCommand | PrFlowPrAction, approvedFingerprints: ReadonlySet<string>, pr: CheckedPr | null): EntryCheck {
  const expanded = expandPlaceholders(command.command, placeholderSample(PR_FLOW_PLACEHOLDERS_BY_KIND[kind], pr));
  const isApproved = approvedFingerprints.has(commandFingerprint(kind, command));
  if (!expanded.ok) return { kind, id: command.id, label: command.label, isApproved, argv: null, error: unknownPlaceholderMessage(kind, expanded.unknown) };
  return { kind, id: command.id, label: command.label, isApproved, argv: kind === 'source' ? null : expanded.argv, error: null };
}

function approvedFingerprints(homeDir: string): string[] {
  const statePath = path.join(homeDir, 'pr-flows-state.json');
  if (!fs.existsSync(statePath)) return [];
  return PrFlowsState.safeParse(parseJsonOrNull(fs.readFileSync(statePath, 'utf8'))).data?.approvedFingerprints ?? [];
}

async function installedPacks(homeDir: string, listedPaths: readonly string[], env: NodeJS.ProcessEnv): Promise<{ packs: PackOnDisk[]; warnings: string[] }> {
  const found = await packDirsUnder(homeDir);
  const packDirs = [...new Set([...found.packDirs, ...listedPaths.map((listedPath) => path.resolve(homeDir, listedPath))])];
  const packs: PackOnDisk[] = [];
  const warnings = found.warning === null ? [] : [found.warning];
  for (const packDir of packDirs) {
    const read = await readPackDir(packDir, env);
    if (!read.ok) {
      warnings.push(`The pack at ${packDir} was skipped: ${read.errors[0] ?? 'unreadable'}`);
      continue;
    }
    if (packs.some((pack) => pack.header.name === read.pack.header.name)) {
      warnings.push(`The pack at ${packDir} was skipped: another pack is already named '${read.pack.header.name}'`);
      continue;
    }
    packs.push(read.pack);
  }
  return { packs, warnings };
}

async function resolvePr(prUrl: string, runCommand: CommandRunner, homeDir: string, env: NodeJS.ProcessEnv): Promise<CheckedPr> {
  const match = PR_URL_PATTERN.exec(prUrl);
  if (!match?.[1] || !match[2]) throw new Error(`--pr must be a pull request URL such as https://github.com/owner/repo/pull/123, not ${prUrl}`);
  const lookup = await runCommand('gh', ['pr', 'view', prUrl, '--json', 'headRefOid', '--jq', '.headRefOid'], { cwd: homeDir, env, timeoutMs: GH_TIMEOUT_MS, maxBufferBytes: GH_OUTPUT_MAX_BYTES });
  const headRefOid = lookup.stdout.trim();
  if (!lookup.ok || !/^[0-9a-f]{40}$/.test(headRefOid)) throw new Error(`gh could not read the head commit of ${prUrl}: ${lookup.stderr.trim() || 'no output'}`);
  return { url: prUrl, repo: match[1], number: Number(match[2]), headRefOid };
}

async function readServerConfig(askSetting: (settingPath: string) => Promise<unknown>): Promise<ConfigReading> {
  const valuesByPath = new Map<string, unknown>();
  for (const settingPath of SERVER_SETTING_PATHS) {
    const reply = AgentSettingsReply.safeParse(await askSetting(settingPath));
    if (!reply.success) throw new Error('Glimmervoid sent a settings reply this command cannot read');
    if (!reply.data.ok) throw new Error(reply.data.error);
    const readout = reply.data.readout;
    if (readout !== null && typeof readout === 'object' && 'value' in readout) valuesByPath.set(settingPath, readout.value);
  }
  const prFlows = Object.fromEntries([...valuesByPath].flatMap(([settingPath, value]) => (settingPath.startsWith('prFlows.') ? [[settingPath.slice('prFlows.'.length), value]] : [])));
  return { configPath: 'the config.json this Glimmervoid runs', configFile: { prFlows, packs: valuesByPath.get('packs') } };
}

async function readConfigFromServer(): Promise<ConfigReading> {
  const { askAgentApi } = await import('./agent-api-cli.ts');
  return readServerConfig((settingPath) => askAgentApi('settings', { command: 'get', path: settingPath }));
}

async function readConfigFile(env: NodeJS.ProcessEnv, homeDir: string): Promise<ConfigReading> {
  const decided = decideConfigPath({ env, homeDir }, (candidate) => fs.existsSync(candidate));
  if (!decided.path && decided.source === 'env') throw new Error(`config file not found: ${decided.envPath}`);
  if (!decided.path) throw new Error(`no config.json at ${decided.homePath}`);
  const configFile = parseJsonOrNull(fs.readFileSync(decided.path, 'utf8'));
  if (configFile === null) throw new Error(`${decided.path} is not valid JSON`);
  return { configPath: decided.path, configFile };
}

async function checkPrFlows({ prUrl, env, homeDir, runCommand, readConfig }: PrFlowsCheckOptions): Promise<PrFlowsCheckReport> {
  if (!fs.existsSync(homeDir)) throw new Error(`the Glimmervoid home ${homeDir} does not exist; start Glimmervoid once or set GLIMMERVOID_HOME`);
  const { configPath, configFile } = await readConfig();
  const config = prFlowsConfig(configFile);
  const packLoad = await installedPacks(homeDir, packPathsOf(configFile), env);
  const approvedPackFingerprints = readApprovedPackFingerprints(homeDir);
  const setup = prFlowSetup(config, packLoad, approvedFingerprints(homeDir));
  const { approved } = prFlowSetup(config, { packs: packLoad.packs.filter((pack) => approvedPackFingerprints.has(pack.fingerprint)), warnings: [] }, approvedFingerprints(homeDir));
  const { commands } = setup;
  const pr = prUrl === null ? null : await resolvePr(prUrl, runCommand, homeDir, env);
  const entries = [
    ...commands.sources.map((source) => entryCheck('source', source, approved, pr)),
    ...commands.actions.map((action) => entryCheck('action', action, approved, pr)),
    ...commands.prActions.map((prAction) => entryCheck('pr-action', prAction, approved, pr)),
  ];
  const warnings = [...new Set([...commands.warnings, ...setup.ruleWarnings])];
  if (!pr) return { configPath, warnings, entries, pr, sourceRuns: [], outOfScopeSources: [] };
  const external = createPrFlowsExternal({ homeDir, baseEnv: () => env, runCommand });
  const sourcesInScope = scopedToRepo(commands.sources, pr.repo);
  const outOfScopeSources = commands.sources.filter((source) => !sourcesInScope.includes(source)).map(({ id, label, repos }) => ({ id, label, repos: repos ?? [] }));
  const runnableSources = sourcesInScope.filter((source) => entries.some((entry) => entry.kind === 'source' && entry.id === source.id && entry.error === null && entry.isApproved));
  const sourceRuns = await Promise.all(runnableSources.map(async (source) => {
    const run = await external.runSource(source, pr);
    return { id: source.id, label: source.label, output: run.ok ? run.output : null, error: run.ok ? null : run.error };
  }));
  return { configPath, warnings, entries, pr, sourceRuns, outOfScopeSources };
}

function entryLine(entry: EntryCheck): string {
  const approval = entry.isApproved ? 'approved' : 'waits for approval in My PRs, or for a pack in Settings, Packs';
  const heading = `${entry.kind} ${entry.id} (${entry.label}): `;
  if (entry.error !== null) return `${heading}invalid, ${entry.error}`;
  const argvText = entry.argv === null ? '' : `\n  would run ${JSON.stringify(entry.argv)}`;
  return `${heading}valid, ${approval}${argvText}`;
}

function sourceRunLines(run: SourceCheck): string[] {
  if (run.output === null) return [`source ${run.id} ran: ${run.error ?? 'unknown error'}`];
  const statusText = run.output.status.map((line) => `${line.label}: ${line.state}`).join(', ');
  return [
    `source ${run.id} ran: ${run.output.findings.length} findings${statusText ? `, ${statusText}` : ''}`,
    ...run.output.findings.map((finding) => `  ${finding.priority} ${finding.path}${finding.lineStart === null ? '' : `:${finding.lineStart}`} ${JSON.stringify([...finding.body].slice(0, 120).join(''))}`),
  ];
}

function reportText(report: PrFlowsCheckReport): string {
  const lines = [`Checked ${report.configPath}`];
  if (report.entries.length === 0) lines.push('No prFlows.sources, prFlows.actions or prFlows.prActions are configured, in config.json or a pack.');
  lines.push(...report.entries.map(entryLine));
  lines.push(...report.warnings.map((warning) => `warning: ${warning}`));
  if (report.pr) lines.push(`Ran the approved sources against ${report.pr.url} at ${report.pr.headRefOid.slice(0, 12)}; a source waiting for approval in My PRs does not run:`, ...report.sourceRuns.flatMap(sourceRunLines), ...report.outOfScopeSources.map((source) => `source ${source.id} skipped: limited to ${source.repos.join(', ')}`));
  if (!report.pr && report.entries.some((entry) => entry.kind === 'source')) lines.push('Pass --pr <url> to run each approved source once against a pull request.');
  return lines.join('\n');
}

function hasProblems(report: PrFlowsCheckReport): boolean {
  return report.warnings.length > 0 || report.entries.some((entry) => entry.error !== null) || report.sourceRuns.some((run) => run.error !== null);
}

async function runPrFlowsCheck(options: PrFlowsCheckOptions & { isJson: boolean }, io: PrFlowsCheckIo): Promise<number> {
  try {
    const report = await checkPrFlows(options);
    io.writeOutput(`${options.isJson ? JSON.stringify(report, null, 2) : reportText(report)}\n`);
    return hasProblems(report) ? 1 : 0;
  } catch (error) {
    io.writeError(`pr-flows check: ${errorMessage(error)}\n`);
    return 1;
  }
}

async function runPrFlowsCheckCli(parsed: Extract<ParsedCommand, { kind: 'run' }>): Promise<number> {
  const env = process.env;
  const homeDir = glimmervoidHomeDir(os.homedir(), env);
  const io = { writeOutput: (text: string) => process.stdout.write(text), writeError: (text: string) => process.stderr.write(text) };
  const readConfig = env[AGENT_URL_ENV] ? readConfigFromServer : () => readConfigFile(env, homeDir);
  return runPrFlowsCheck({
    prUrl: typeof parsed.values.pr === 'string' ? parsed.values.pr : null, isJson: parsed.values.json === true,
    env, homeDir, runCommand: runCommandSafely, readConfig,
  }, io);
}

interface PrActionReportOptions {
  outcome: string | null;
  message: string | null;
  env: NodeJS.ProcessEnv;
}

function refusalText(replyText: string): string {
  const reply = parseJsonOrNull(replyText);
  if (reply !== null && typeof reply === 'object' && 'error' in reply && typeof reply.error === 'string') return reply.error;
  return replyText.trim() || 'no reply';
}

async function runPrActionReport({ outcome, message, env }: PrActionReportOptions, io: PrFlowsCheckIo): Promise<number> {
  const reportUrl = env[PR_ACTION_REPORT_URL_ENV];
  const token = env[PR_ACTION_TOKEN_ENV];
  if (!reportUrl || !token) {
    io.writeError(`pr-action report runs from a PR action command or a process it started: ${PR_ACTION_REPORT_URL_ENV} and ${PR_ACTION_TOKEN_ENV} are not set\n`);
    return 1;
  }
  const body = PrActionReportBody.safeParse({ outcome, ...(message === null ? {} : { message }) });
  if (!body.success) {
    io.writeError('--outcome must be started, done, failed or refused, and --message at most 500 characters\n');
    return 1;
  }
  const { postToAgentIngress } = await import('./agent-api-cli.ts');
  const reply = await postToAgentIngress({ endpoint: new URL(reportUrl), token, body: body.data, deadline: AbortSignal.timeout(REPORT_TIMEOUT_MS) })
    .catch((error: unknown) => ({ hasSuccessStatus: false, text: JSON.stringify({ error: `could not reach Glimmervoid: ${errorMessage(error)}` }) }));
  if (!reply.hasSuccessStatus) {
    io.writeError(`Glimmervoid did not take the report: ${refusalText(reply.text)}\n`);
    return 1;
  }
  io.writeOutput(`Reported ${body.data.outcome}\n`);
  return 0;
}

async function runPrActionReportCli(parsed: Extract<ParsedCommand, { kind: 'run' }>): Promise<number> {
  return runPrActionReport({
    outcome: typeof parsed.values.outcome === 'string' ? parsed.values.outcome : null,
    message: typeof parsed.values.message === 'string' ? parsed.values.message : null,
    env: process.env,
  }, { writeOutput: (text) => process.stdout.write(text), writeError: (text) => process.stderr.write(text) });
}

export { readConfigFile, runPrActionReport, runPrActionReportCli, runPrFlowsCheck, runPrFlowsCheckCli };
