import { runCommandSafely } from '../child-process-safe.ts';
import type { CommandRunOptions, CommandRunResult } from '../child-process-safe.ts';
import { withoutGlimmervoidSecrets } from '../../session/core/spawn-env.ts';
import { ReportedPrFlowActionOutcome, PrFlowSourceOutput } from '../../shared/contracts/pr-flows.ts';
import type { PrFlowActionOutput, PrFlowCommand, PrFlowItem } from '../../shared/contracts/pr-flows.ts';
import type { MyPr } from '../../shared/contracts/my-prs.ts';
import { parseJsonOrNull } from '../core/json-core.ts';
import { expandPlaceholders } from './core/pr-flows-core.ts';

const OUTPUT_MAX_BYTES = 1024 * 1024;
const ACTION_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
const ERROR_MAX_CHARACTERS = 200;

type PrFlowTarget = Pick<MyPr, 'url' | 'repo' | 'number' | 'headRefOid'>;
type SourceRun = { ok: true; output: PrFlowSourceOutput } | { ok: false; error: string };

interface PrFlowsExternalOptions {
  homeDir: string;
  baseEnv?: () => NodeJS.ProcessEnv;
  runCommand?: (command: string, args: string[], options: CommandRunOptions) => Promise<CommandRunResult>;
}

function firstCharacters(text: string): string {
  return [...text.trim()].slice(0, ERROR_MAX_CHARACTERS).join('');
}

function reportedActionOutcome(stdout: string): PrFlowActionOutput | null {
  const lastLine = stdout.trim().split('\n').at(-1) ?? '';
  const reported = ReportedPrFlowActionOutcome.safeParse(parseJsonOrNull(stdout)).data ?? ReportedPrFlowActionOutcome.safeParse(parseJsonOrNull(lastLine)).data;
  if (!reported) return null;
  return { outcome: reported.outcome, message: firstCharacters(reported.message ?? '') };
}

function unknownPlaceholderError(name: string, knownNames: string): string {
  return firstCharacters(`The command names {${name}}, which is not a placeholder; use ${knownNames}.`);
}

function createPrFlowsExternal({ homeDir, baseEnv = () => process.env, runCommand = runCommandSafely }: PrFlowsExternalOptions) {
  function placeholderValues(pr: PrFlowTarget): Record<string, string> {
    return { prUrl: pr.url, repo: pr.repo, number: String(pr.number), head: pr.headRefOid };
  }

  function commandEnv(pr: PrFlowTarget): NodeJS.ProcessEnv {
    return {
      ...withoutGlimmervoidSecrets(baseEnv()),
      GLIMMERVOID_PR_URL: pr.url, GLIMMERVOID_PR_REPO: pr.repo, GLIMMERVOID_PR_NUMBER: String(pr.number), GLIMMERVOID_PR_HEAD: pr.headRefOid,
    };
  }

  async function runSource(source: PrFlowCommand, pr: PrFlowTarget): Promise<SourceRun> {
    const expanded = expandPlaceholders(source.command, placeholderValues(pr));
    if (!expanded.ok) return { ok: false, error: unknownPlaceholderError(expanded.unknown, '{prUrl}, {repo}, {number} or {head}') };
    const [program, ...args] = expanded.argv;
    if (program === undefined) return { ok: false, error: 'The command is empty.' };
    const run = await runCommand(program, args, { cwd: homeDir, env: commandEnv(pr), timeoutMs: source.timeoutSeconds * 1000, maxBufferBytes: OUTPUT_MAX_BYTES });
    if (!run.ok) return { ok: false, error: `The command failed: ${firstCharacters(run.stderr) || 'no error output'}` };
    const output = PrFlowSourceOutput.safeParse(parseJsonOrNull(run.stdout));
    if (!output.success) return { ok: false, error: `The command printed no valid findings JSON: ${output.error.issues[0]?.message ?? 'unreadable output'}` };
    return { ok: true, output: output.data };
  }

  async function runAction(action: PrFlowCommand, pr: PrFlowTarget, item: PrFlowItem): Promise<PrFlowActionOutput> {
    const values = { ...placeholderValues(pr), itemPath: item.path, itemLine: item.lineStart === null ? '' : String(item.lineStart) };
    const expanded = expandPlaceholders(action.command, values);
    if (!expanded.ok) return { outcome: 'failed', message: unknownPlaceholderError(expanded.unknown, '{prUrl}, {repo}, {number}, {head}, {itemPath} or {itemLine}') };
    const [program, ...args] = expanded.argv;
    if (program === undefined) return { outcome: 'failed', message: 'The command is empty.' };
    const env = { ...commandEnv(pr), GLIMMERVOID_ITEM_JSON: JSON.stringify(item) };
    const run = await runCommand(program, args, { cwd: homeDir, env, timeoutMs: action.timeoutSeconds * 1000, maxBufferBytes: ACTION_OUTPUT_MAX_BYTES });
    const reported = reportedActionOutcome(run.stdout);
    if (reported) return reported;
    if (run.ok) return { outcome: 'done', message: '' };
    return { outcome: 'failed', message: firstCharacters(run.stderr) || 'The command failed with no error output.' };
  }

  return { runSource, runAction };
}

type PrFlowsExternal = ReturnType<typeof createPrFlowsExternal>;

export { createPrFlowsExternal };
export type { PrFlowsExternal };
