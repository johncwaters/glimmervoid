import { FactorySettings } from '../../shared/contracts/browser-config.ts';
import { targets } from './targets.ts';
import type { TargetName } from './targets.ts';

export const usage = `Usage: node test/factory/run.ts [options]
Runs real Claude intents sequentially; bills Claude usage.
  --help                     Print usage
  --list-intents             Print the fixed catalog
  --runs <n>                 Positive run count (default 1)
  --target <name>            throwaway (default) or gated-clone
  --intent <name>            Catalog intent (default one-file-change or gated-one-file-change for its target)
  --intent-file <path>       Queue JSON; optional name and expectedEnd; refused needs expectedRefusal
  --artifacts <dir>          Record parent directory
  --keep                    Keep seed, home and worktrees after passes
  --no-telemetry             Disable instance telemetry and the run summary event
  --reviewer-model <model>   Factory reviewer model
  --verifier-model <model>   Factory verifier model
  --live-workers <n>         Factory maxLiveWorkers
  --watch-window <minutes>   Factory watchWindowMinutes
Defaults are shipped factory settings; the seed supplies all default checks.
Target work limits are 30 minutes for throwaway and 90 for gated-clone, plus the watch window.
The gated clone uses the shipped checks: npm run typecheck, npm run lint, npm test.
Telemetry is also off under DO_NOT_TRACK=1, GLIMMERVOID_TELEMETRY=0, CI=true or Settings > Privacy in the real config.
Each verdict records the summary event as sent, failed, skipped-no-consent or skipped-remote-disabled.`;

export type FactoryOverrides = NonNullable<ReturnType<typeof FactorySettings.parse>>;
export interface Arguments {
  help: boolean;
  listIntents: boolean;
  runs: number;
  target: TargetName;
  intentName: string;
  intentFile?: string;
  artifacts?: string;
  keep: boolean;
  noTelemetry: boolean;
  factory: FactoryOverrides;
}

export function parseArguments(argumentsPassed: string[]): Arguments {
  const options: Arguments = { help: false, listIntents: false, runs: 1, target: 'throwaway', intentName: 'one-file-change', keep: false, noTelemetry: false, factory: {} };
  let hasIntentName = false;
  for (let index = 0; index < argumentsPassed.length; index++) {
    const flag = argumentsPassed[index];
    if (flag === '--help') { options.help = true; continue; }
    if (flag === '--list-intents') { options.listIntents = true; continue; }
    if (flag === '--keep') { options.keep = true; continue; }
    if (flag === '--no-telemetry') { options.noTelemetry = true; continue; }
    if (!['--runs', '--target', '--intent', '--intent-file', '--artifacts', '--reviewer-model', '--verifier-model', '--live-workers', '--watch-window'].includes(flag ?? '')) throw new Error(`Unknown option: ${flag}`);
    const value = argumentsPassed[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    switch (flag) {
      case '--target':
        if (value !== 'throwaway' && value !== 'gated-clone') throw new Error('--target must be throwaway or gated-clone');
        options.target = value;
        break;
      case '--runs':
        options.runs = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(options.runs) || options.runs < 1) throw new Error('--runs must be a positive integer');
        break;
      case '--intent': options.intentName = value; hasIntentName = true; break;
      case '--intent-file': options.intentFile = value; break;
      case '--artifacts': options.artifacts = value; break;
      case '--reviewer-model': options.factory.reviewerModel = value; break;
      case '--verifier-model': options.factory.verifierModel = value; break;
      case '--live-workers': options.factory.maxLiveWorkers = Number(value); break;
      case '--watch-window': options.factory.watchWindowMinutes = Number(value); break;
    }
  }
  if (hasIntentName && options.intentFile) throw new Error('Choose --intent or --intent-file');
  if (!hasIntentName) options.intentName = targets[options.target].defaultIntent;
  options.factory = FactorySettings.unwrap().unwrap().parse(options.factory);
  return options;
}
