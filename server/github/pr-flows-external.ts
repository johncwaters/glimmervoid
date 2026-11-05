import { runCommandSafely } from '../child-process-safe.ts';
import type { CommandRunOptions, CommandRunResult } from '../child-process-safe.ts';
import { withoutGlimmervoidSecrets } from '../../session/core/spawn-env.ts';
import { ReportedPrFlowActionOutcome, PrFlowSourceOutput } from '../../shared/contracts/pr-flows.ts';
import type { PrFlowActionOutput, PrFlowCommand, PrFlowItem } from '../../shared/contracts/pr-flows.ts';
import type { MyPr } from '../../shared/contracts/my-prs.ts';
import { parseJsonOrNull } from '../core/json-core.ts';
import { expandPlaceholders, prActionPlaceholderValues, sourcePlaceholderValues, unknownPlaceholderMessage } from './core/pr-flows-core.ts';

const OUTPUT_MAX_BYTES = 1024 * 1024;
const ACTION_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
const ERROR_MAX_CHARACTERS = 200;

type PrFlowTarget = Pick<MyPr, 'url' | 'repo' | 'number' | 'headRefOid'>;
type PrActionTarget = Pick<MyPr, 'url' | 'repo' | 'number' | 'headRefOid' | 'headRefName' | 'baseRefName'>;
type ActionInvocation = { values: Record<string, string>; kind: 'action' | 'pr-action'; env: NodeJS.ProcessEnv };
type SourceRun = { ok: true; output: PrFlowSourceOutput } | { ok: false; error: string };

interface PrFlowsExternalOptions {
  homeDir: string;
  baseEnv?: () => NodeJS.ProcessEnv;
  runCommand?: (command: string, args: string[], options: CommandRunOptions) => Promise<CommandRunResult>;
}

const UNBOUNDED_PR_FIELDS = new Set(['threads', 'reviewItems']);

function boundedPrJson(pr: PrActionTarget): string {
  return JSON.stringify(Object.fromEntries(Object.entries(pr).filter(([field]) => !UNBOUNDED_PR_FIELDS.has(field))));
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;

function firstCharacters(text: string): string {
  return [...text.replace(CONTROL_CHARACTERS, ' ').trim()].slice(0, ERROR_MAX_CHARACTERS).join('');
}

function reportedActionOutcome(stdout: string): PrFlowActionOutput | null {
  const lastLine = stdout.trim().split('\n').at(-1) ?? '';
  const reported = ReportedPrFlowActionOutcome.safeParse(parseJsonOrNull(stdout)).data ?? ReportedPrFlowActionOutcome.safeParse(parseJsonOrNull(lastLine)).data;
  if (!reported) return null;
  return { outcome: reported.outcome, message: firstCharacters(reported.message ?? '') };
}

function createPrFlowsExternal({ homeDir, baseEnv = () => process.env, runCommand = runCommandSafely }: PrFlowsExternalOptions) {
  function commandEnv(pr: PrFlowTarget): NodeJS.ProcessEnv {
    return {
      ...withoutGlimmervoidSecrets(baseEnv()),
      GLIMMERVOID_PR_URL: pr.url, GLIMMERVOID_PR_REPO: pr.repo, GLIMMERVOID_PR_NUMBER: String(pr.number), GLIMMERVOID_PR_HEAD: pr.headRefOid,
    };
  }

  async function runSource(source: PrFlowCommand, pr: PrFlowTarget): Promise<SourceRun> {
    const expanded = expandPlaceholders(source.command, sourcePlaceholderValues(pr));
    if (!expanded.ok) return { ok: false, error: firstCharacters(unknownPlaceholderMessage('source', expanded.unknown)) };
    const [program, ...args] = expanded.argv;
    if (program === undefined) return { ok: false, error: 'The command is empty.' };
    const run = await runCommand(program, args, { cwd: homeDir, env: commandEnv(pr), timeoutMs: source.timeoutSeconds * 1000, maxBufferBytes: OUTPUT_MAX_BYTES });
    if (!run.ok) return { ok: false, error: `The command failed: ${firstCharacters(run.stderr) || 'no error output'}` };
    const output = PrFlowSourceOutput.safeParse(parseJsonOrNull(run.stdout));
    if (!output.success) return { ok: false, error: `The command printed no valid findings JSON: ${output.error.issues[0]?.message ?? 'unreadable output'}` };
    return { ok: true, output: output.data };
  }

  function itemInvocation(pr: PrActionTarget, item: PrFlowItem): ActionInvocation {
    return {
      values: { ...sourcePlaceholderValues(pr), itemPath: item.path, itemLine: item.lineStart === null ? '' : String(item.lineStart) },
      kind: 'action',
      env: { ...commandEnv(pr), GLIMMERVOID_ITEM_JSON: JSON.stringify(item) },
    };
  }

  function prInvocation(pr: PrActionTarget, extraEnv: Readonly<Record<string, string>>): ActionInvocation {
    return {
      values: prActionPlaceholderValues(pr),
      kind: 'pr-action',
      env: { ...commandEnv(pr), GLIMMERVOID_PR_HEAD_REF: pr.headRefName, GLIMMERVOID_PR_BASE_REF: pr.baseRefName, GLIMMERVOID_PR_JSON: boundedPrJson(pr), ...extraEnv },
    };
  }

  async function runAction(action: PrFlowCommand, pr: PrActionTarget, item?: PrFlowItem, extraEnv: Readonly<Record<string, string>> = {}): Promise<PrFlowActionOutput> {
    const { values, kind, env } = item === undefined ? prInvocation(pr, extraEnv) : itemInvocation(pr, item);
    const expanded = expandPlaceholders(action.command, values);
    if (!expanded.ok) return { outcome: 'failed', message: firstCharacters(unknownPlaceholderMessage(kind, expanded.unknown)) };
    const [program, ...args] = expanded.argv;
    if (program === undefined) return { outcome: 'failed', message: 'The command is empty.' };
    const timeoutMs = action.timeoutSeconds * 1000;
    const startedAtMs = performance.now();
    const run = await runCommand(program, args, { cwd: homeDir, env, timeoutMs, maxBufferBytes: ACTION_OUTPUT_MAX_BYTES });
    const reported = reportedActionOutcome(run.stdout);
    if (reported) return reported;
    if (run.ok) return { outcome: 'done', message: '' };
    if (performance.now() - startedAtMs >= timeoutMs) return { outcome: 'failed', message: `timed out after ${action.timeoutSeconds}s` };
    return { outcome: 'failed', message: firstCharacters(run.stderr) || 'The command failed with no error output.' };
  }

  return { runSource, runAction };
}

type PrFlowsExternal = ReturnType<typeof createPrFlowsExternal>;

export { createPrFlowsExternal };
export type { PrFlowsExternal };
