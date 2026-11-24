import { runCommandSafely } from '../child-process-safe.ts';
import type { CommandRunOptions, CommandRunResult } from '../child-process-safe.ts';
import { withoutGlimmervoidSecrets } from '../../session/core/spawn-env.ts';
import type { PackCommandSettings } from './pack-settings.ts';
import { maskSecrets } from './core/pack-core.ts';

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

