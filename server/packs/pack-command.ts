import { runCommandSafely } from '../child-process-safe.ts';
import type { CommandRunOptions, CommandRunResult } from '../child-process-safe.ts';
import { withoutGlimmervoidSecrets } from '../../session/core/spawn-env.ts';
import type { PackCommandSettings } from './pack-settings.ts';
import { maskSecrets, maskSecretsInJson, packCommandRef } from './core/pack-core.ts';
import type { ScheduledPackJob } from './core/pack-core.ts';
import { PACK_DIR_PLACEHOLDER } from '../../shared/contracts/pack.ts';
import type { PackOnDisk } from '../../shared/contracts/pack.ts';
import { PackStoreValue } from '../../shared/contracts/pack-bridge.ts';
import { parseJsonOrNull } from '../core/json-core.ts';

const ERROR_MAX_CHARACTERS = 200;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;

export type RunCommand = (command: string, args: string[], options: CommandRunOptions) => Promise<CommandRunResult>;

export const NO_COMMAND_SETTINGS: PackCommandSettings = { env: {}, secretValues: [], missingKeys: [], unreadable: null };

export function firstCharacters(text: string): string {
  return [...text.replace(CONTROL_CHARACTERS, ' ').trim()].slice(0, ERROR_MAX_CHARACTERS).join('');
}

type PackCommandRun = { run: CommandRunResult; timedOut: boolean; errorText: (text: string) => string };

export function createPackCommandRunner({ homeDir, baseEnv = () => process.env, runCommand = runCommandSafely }: {
  homeDir: string;
  baseEnv?: () => NodeJS.ProcessEnv;
  runCommand?: RunCommand;
}) {
  async function run(argv: readonly string[], { settings, extraEnv, timeoutMs, maxBufferBytes }: {
    settings: PackCommandSettings;
    extraEnv: Readonly<Record<string, string>>;
    timeoutMs: number;
    maxBufferBytes: number;
  }): Promise<PackCommandRun | { emptyCommand: true }> {
    const [program, ...args] = argv;
    if (program === undefined) return { emptyCommand: true };
    const env = { ...withoutGlimmervoidSecrets(baseEnv()), ...settings.env, ...extraEnv };
    const startedAtMs = performance.now();
    const run = await runCommand(program, args, { cwd: homeDir, env, timeoutMs, maxBufferBytes });
    return {
      run,
      timedOut: !run.ok && performance.now() - startedAtMs >= timeoutMs,
      errorText: (text) => firstCharacters(maskSecrets(text, settings.secretValues)),
    };
  }

  return { run };
}

const JOB_OUTPUT_MAX_BYTES = 1024 * 1024;

export function createPackJobRunner({ homeDir, packInUse, commandSettings, saveOutput, log }: {
  homeDir: string;
  packInUse: (packName: string) => PackOnDisk | null;
  commandSettings: (pack: PackOnDisk, commandRef: string) => Promise<PackCommandSettings>;
  saveOutput: (packName: string, jobId: string, value: unknown) => Promise<{ ok: true } | { ok: false; error: string }>;
  log: { warn: (message: string) => void };
}) {
  const runner = createPackCommandRunner({ homeDir });

  function warn(scheduled: ScheduledPackJob, text: string): void {
    log.warn(`[packs] the scheduled run of job ${scheduled.job.label} in pack ${scheduled.pack} ${text}`);
  }

  async function runJob(scheduled: ScheduledPackJob): Promise<void> {
    const pack = packInUse(scheduled.pack);
    if (pack === null) return;
    const settings = await commandSettings(pack, packCommandRef('job', scheduled.job.id));
    if (settings.unreadable !== null) return warn(scheduled, `did not run: ${settings.unreadable}`);
    if (settings.missingKeys.length > 0) return warn(scheduled, `waits for its settings ${settings.missingKeys.join(', ')}`);
    const argv = scheduled.job.command.map((word) => word.replaceAll(PACK_DIR_PLACEHOLDER, scheduled.packDir));
    const outcome = await runner.run(argv, { settings, extraEnv: { GLIMMERVOID_PACK_JOB_ID: scheduled.job.id }, timeoutMs: scheduled.job.timeoutSeconds * 1000, maxBufferBytes: JOB_OUTPUT_MAX_BYTES });
    if ('emptyCommand' in outcome) return warn(scheduled, 'has an empty command');
    if (outcome.timedOut) return warn(scheduled, `timed out after ${scheduled.job.timeoutSeconds}s`);
    if (!outcome.run.ok) return warn(scheduled, `failed: ${outcome.errorText(outcome.run.stderr) || 'no error output'}`);
    const printed = PackStoreValue.safeParse(maskSecretsInJson(parseJsonOrNull(outcome.run.stdout), settings.secretValues));
    if (!printed.success || printed.data === null || printed.data === undefined) return warn(scheduled, 'printed no JSON value on stdout');
    const saved = await saveOutput(scheduled.pack, scheduled.job.id, printed.data);
    if (!saved.ok) warn(scheduled, `could not save its output: ${saved.error}`);
  }

  return { runJob };
}

