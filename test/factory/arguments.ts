import { FactorySettings } from '../../shared/contracts/browser-config.ts';

export const usage = `Usage: node test/factory/run.ts [options]
Runs real Claude intents sequentially; bills Claude usage.
  --help                     Print usage
  --list-intents             Print the fixed catalog
  --runs <n>                 Positive run count (default 1)
  --intent <name>            Catalog intent (default one-file-change)
  --intent-file <path>       Queue JSON; optional name and expectedEnd; refused needs expectedRefusal
  --artifacts <dir>          Record parent directory
  --keep                    Keep seed, home and worktrees after passes
  --reviewer-model <model>   Factory reviewer model
  --verifier-model <model>   Factory verifier model
  --live-workers <n>         Factory maxLiveWorkers
  --watch-window <minutes>   Factory watchWindowMinutes
Defaults are shipped factory settings; the seed supplies all default checks.
Each run has a wall-clock limit of 30 minutes plus the watch window, which must pass before an intent completes.`;

export type FactoryOverrides = NonNullable<ReturnType<typeof FactorySettings.parse>>;
export interface Arguments {
  help: boolean;
  listIntents: boolean;
  runs: number;
  intentName: string;
  intentFile?: string;
  artifacts?: string;
  keep: boolean;
  factory: FactoryOverrides;
}

export function parseArguments(argumentsPassed: string[]): Arguments {
  const options: Arguments = { help: false, listIntents: false, runs: 1, intentName: 'one-file-change', keep: false, factory: {} };
  let hasIntentName = false;
  for (let index = 0; index < argumentsPassed.length; index++) {
    const flag = argumentsPassed[index];
    if (flag === '--help') { options.help = true; continue; }
    if (flag === '--list-intents') { options.listIntents = true; continue; }
    if (flag === '--keep') { options.keep = true; continue; }
    if (!['--runs', '--intent', '--intent-file', '--artifacts', '--reviewer-model', '--verifier-model', '--live-workers', '--watch-window'].includes(flag ?? '')) throw new Error(`Unknown option: ${flag}`);
    const value = argumentsPassed[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    switch (flag) {
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
  options.factory = FactorySettings.unwrap().unwrap().parse(options.factory);
  return options;
}
