import { AGENT_API_VERBS } from '../../shared/contracts/session.ts';

type GlobalOptions = {
  configPath: string | null;
  port: string | null;
};

type ParsedCommandLine =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'server'; globalOptions: GlobalOptions }
  | { kind: 'subcommand'; name: string; subcommandArgs: string[]; globalOptions: GlobalOptions };

type ScanState = GlobalOptions & { wantsHelp: boolean; wantsVersion: boolean; wantsDoctor: boolean };

const SUBCOMMANDS_HONORING_TRAILING_GLOBAL_OPTIONS: ReadonlySet<string> = new Set(['doctor', 'pair', 'visions']);

const SUBCOMMANDS_HONORING_A_LEADING_HELP_OR_VERSION: ReadonlySet<string> = new Set(AGENT_API_VERBS);

const OPTIONS_TAKING_A_VALUE: Record<string, 'configPath' | 'port'> = { '--config': 'configPath', '--port': 'port' };

function scanGlobalOption(argv: readonly string[], index: number, state: ScanState): number {
  const token = argv[index];
  const valueKey = OPTIONS_TAKING_A_VALUE[token];
  if (valueKey) {
    const value = argv[index + 1];
    if (value !== undefined) state[valueKey] = value;
    return index + 2;
  }
  if (token === '--help' || token === '-h') state.wantsHelp = true;
  if (token === '--version') state.wantsVersion = true;
  if (token === '--doctor') state.wantsDoctor = true;
  return index + 1;
}

function scanTrailingGlobalOptions(subcommandArgs: readonly string[], state: ScanState): void {
  let index = 0;
  while (index < subcommandArgs.length) {
    if (!subcommandArgs[index].startsWith('-')) {
      index += 1;
      continue;
    }
    index = scanGlobalOption(subcommandArgs, index, state);
  }
}

function scanLeadingHelpOrVersion(subcommandArgs: readonly string[], state: ScanState): void {
  const firstArgument = subcommandArgs[0];
  if (firstArgument === '--help' || firstArgument === '-h') state.wantsHelp = true;
  if (firstArgument === '--version') state.wantsVersion = true;
}

function parseCommandLine(argv: readonly string[]): ParsedCommandLine {
  const state: ScanState = { configPath: null, port: null, wantsHelp: false, wantsVersion: false, wantsDoctor: false };
  let index = 0;
  while (index < argv.length && argv[index].startsWith('-')) index = scanGlobalOption(argv, index, state);
  const name = argv[index];
  const subcommandArgs = argv.slice(index + 1);
  if (name !== undefined && SUBCOMMANDS_HONORING_TRAILING_GLOBAL_OPTIONS.has(name)) scanTrailingGlobalOptions(subcommandArgs, state);
  if (name !== undefined && SUBCOMMANDS_HONORING_A_LEADING_HELP_OR_VERSION.has(name)) scanLeadingHelpOrVersion(subcommandArgs, state);
  if (state.wantsHelp) return { kind: 'help' };
  if (state.wantsVersion) return { kind: 'version' };
  const globalOptions = { configPath: state.configPath, port: state.port };
  if (state.wantsDoctor) return { kind: 'subcommand', name: 'doctor', subcommandArgs: [], globalOptions };
  if (name === undefined) return { kind: 'server', globalOptions };
  return { kind: 'subcommand', name, subcommandArgs, globalOptions };
}

export { parseCommandLine };
