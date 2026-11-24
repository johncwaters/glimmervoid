import type { PackCommandKind } from '../../shared/contracts/pack.ts';
import { NO_COMMAND_SETTINGS, createPackCommandRunner, firstCharacters } from '../packs/pack-command.ts';
import type { RunCommand } from '../packs/pack-command.ts';
import { maskSecretsInJson } from '../packs/core/pack-core.ts';
import type { PackCommandSettings } from '../packs/pack-settings.ts';
import { ReportedPrFlowActionOutcome, PrFlowSourceOutput } from '../../shared/contracts/pr-flows.ts';
import type { PrFlowActionOutput, PrFlowCommand, PrFlowItem } from '../../shared/contracts/pr-flows.ts';
import type { MyPr } from '../../shared/contracts/my-prs.ts';
import { parseJsonOrNull } from '../core/json-core.ts';
import { expandPlaceholders, prActionPlaceholderValues, sourcePlaceholderValues, unknownPlaceholderMessage } from './core/pr-flows-core.ts';

const OUTPUT_MAX_BYTES = 1024 * 1024;
const ACTION_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;

type PrFlowTarget = Pick<MyPr, 'url' | 'repo' | 'number' | 'headRefOid'>;
type PrActionTarget = Pick<MyPr, 'url' | 'repo' | 'number' | 'headRefOid' | 'headRefName' | 'baseRefName'>;
type ActionInvocation = { values: Record<string, string>; kind: 'action' | 'pr-action'; env: Record<string, string> };
type SourceRun = { ok: true; output: PrFlowSourceOutput } | { ok: false; error: string };

type CommandSettingsFor = (kind: PackCommandKind, commandId: string) => Promise<PackCommandSettings>;

interface PrFlowsExternalOptions {
  homeDir: string;
  baseEnv?: () => NodeJS.ProcessEnv;
  runCommand?: RunCommand;
  commandSettings?: CommandSettingsFor;
}

const UNBOUNDED_PR_FIELDS = new Set(['threads', 'reviewItems']);

function boundedPrJson(pr: PrActionTarget): string {
  return JSON.stringify(Object.fromEntries(Object.entries(pr).filter(([field]) => !UNBOUNDED_PR_FIELDS.has(field))));
}

function reportedActionOutcome(stdout: string, errorText: (text: string) => string): PrFlowActionOutput | null {
  const lastLine = stdout.trim().split('\n').at(-1) ?? '';
  const reported = ReportedPrFlowActionOutcome.safeParse(parseJsonOrNull(stdout)).data ?? ReportedPrFlowActionOutcome.safeParse(parseJsonOrNull(lastLine)).data;
  if (!reported) return null;
  return { outcome: reported.outcome, message: errorText(reported.message ?? '') };
}

function createPrFlowsExternal({ homeDir, baseEnv = () => process.env, runCommand, commandSettings = async () => NO_COMMAND_SETTINGS }: PrFlowsExternalOptions) {
  const runner = createPackCommandRunner({ homeDir, baseEnv, ...(runCommand === undefined ? {} : { runCommand }) });

  function prEnv(pr: PrFlowTarget): Record<string, string> {
    return { GLIMMERVOID_PR_URL: pr.url, GLIMMERVOID_PR_REPO: pr.repo, GLIMMERVOID_PR_NUMBER: String(pr.number), GLIMMERVOID_PR_HEAD: pr.headRefOid };
  }

  async function runSource(source: PrFlowCommand, pr: PrFlowTarget): Promise<SourceRun> {
    const expanded = expandPlaceholders(source.command, sourcePlaceholderValues(pr));
    if (!expanded.ok) return { ok: false, error: firstCharacters(unknownPlaceholderMessage('source', expanded.unknown)) };
    const settings = await commandSettings('pr-source', source.id);
    if (settings.unreadable !== null) return { ok: false, error: firstCharacters(settings.unreadable) };
    const outcome = await runner.run(expanded.argv, { settings, extraEnv: prEnv(pr), timeoutMs: source.timeoutSeconds * 1000, maxBufferBytes: OUTPUT_MAX_BYTES });
    if ('emptyCommand' in outcome) return { ok: false, error: 'The command is empty.' };
    if (!outcome.run.ok) return { ok: false, error: `The command failed: ${outcome.errorText(outcome.run.stderr) || 'no error output'}` };
    const output = PrFlowSourceOutput.safeParse(maskSecretsInJson(parseJsonOrNull(outcome.run.stdout), settings.secretValues));
    if (!output.success) return { ok: false, error: `The command printed no valid findings JSON: ${output.error.issues[0]?.message ?? 'unreadable output'}` };
    return { ok: true, output: output.data };
  }

  function itemInvocation(pr: PrActionTarget, item: PrFlowItem): ActionInvocation {
    return {
      values: { ...sourcePlaceholderValues(pr), itemPath: item.path, itemLine: item.lineStart === null ? '' : String(item.lineStart) },
      kind: 'action',
      env: { ...prEnv(pr), GLIMMERVOID_ITEM_JSON: JSON.stringify(item) },
    };
  }

  function prInvocation(pr: PrActionTarget, extraEnv: Readonly<Record<string, string>>): ActionInvocation {
    return {
      values: prActionPlaceholderValues(pr),
      kind: 'pr-action',
      env: { ...prEnv(pr), GLIMMERVOID_PR_HEAD_REF: pr.headRefName, GLIMMERVOID_PR_BASE_REF: pr.baseRefName, GLIMMERVOID_PR_JSON: boundedPrJson(pr), ...extraEnv },
    };
  }

  async function runAction(action: PrFlowCommand, pr: PrActionTarget, item?: PrFlowItem, extraEnv: Readonly<Record<string, string>> = {}): Promise<PrFlowActionOutput> {
    const { values, kind, env } = item === undefined ? prInvocation(pr, extraEnv) : itemInvocation(pr, item);
    const expanded = expandPlaceholders(action.command, values);
    if (!expanded.ok) return { outcome: 'failed', message: firstCharacters(unknownPlaceholderMessage(kind, expanded.unknown)) };
    const settings = await commandSettings(kind === 'action' ? 'pr-item-action' : 'pr-action', action.id);
    if (settings.unreadable !== null) return { outcome: 'failed', message: firstCharacters(settings.unreadable) };
    const outcome = await runner.run(expanded.argv, { settings, extraEnv: env, timeoutMs: action.timeoutSeconds * 1000, maxBufferBytes: ACTION_OUTPUT_MAX_BYTES });
    if ('emptyCommand' in outcome) return { outcome: 'failed', message: 'The command is empty.' };
    const reported = reportedActionOutcome(outcome.run.stdout, outcome.errorText);
    if (reported) return reported;
    if (outcome.run.ok) return { outcome: 'done', message: '' };
    if (outcome.timedOut) return { outcome: 'failed', message: `timed out after ${action.timeoutSeconds}s` };
    return { outcome: 'failed', message: outcome.errorText(outcome.run.stderr) || 'The command failed with no error output.' };
  }

  return { runSource, runAction };
}

type PrFlowsExternal = ReturnType<typeof createPrFlowsExternal>;

export { createPrFlowsExternal };
export type { PrFlowsExternal };
