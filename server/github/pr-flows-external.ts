import { runCommandSafely } from '../child-process-safe.ts';
import type { CommandRunOptions, CommandRunResult } from '../child-process-safe.ts';
import { withoutGlimmervoidSecrets } from '../../session/core/spawn-env.ts';
import { PrFlowSourceOutput } from '../../shared/contracts/pr-flows.ts';
import type { PrFlowCommand } from '../../shared/contracts/pr-flows.ts';
import type { MyPr } from '../../shared/contracts/my-prs.ts';
import { parseJsonOrNull } from '../core/json-core.ts';
import { expandPlaceholders } from './core/pr-flows-core.ts';

const OUTPUT_MAX_BYTES = 1024 * 1024;
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
    if (!expanded.ok) return { ok: false, error: `The command names {${expanded.unknown}}, which is not a placeholder; use {prUrl}, {repo}, {number} or {head}.` };
    const [program, ...args] = expanded.argv;
    if (program === undefined) return { ok: false, error: 'The command is empty.' };
    const run = await runCommand(program, args, { cwd: homeDir, env: commandEnv(pr), timeoutMs: source.timeoutSeconds * 1000, maxBufferBytes: OUTPUT_MAX_BYTES });
    if (!run.ok) return { ok: false, error: `The command failed: ${firstCharacters(run.stderr) || 'no error output'}` };
    const output = PrFlowSourceOutput.safeParse(parseJsonOrNull(run.stdout));
    if (!output.success) return { ok: false, error: `The command printed no valid findings JSON: ${output.error.issues[0]?.message ?? 'unreadable output'}` };
    return { ok: true, output: output.data };
  }

  return { runSource };
}

type PrFlowsExternal = ReturnType<typeof createPrFlowsExternal>;

export { createPrFlowsExternal };
export type { PrFlowsExternal };
