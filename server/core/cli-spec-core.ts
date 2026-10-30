import { parseArgs } from 'node:util';

const PROGRAM_NAME = 'glimmervoid';
const USAGE_COLUMN_WIDTH = 20;
const HELP_OPTION: OptionSpec = { name: 'help', short: 'h', type: 'boolean', summary: 'Print this help' };

interface OptionSpec {
  name: string;
  short?: string;
  type: 'boolean' | 'string';
  valueName?: string;
  summary: string;
}

interface PositionalSpec {
  usage: string;
  min: number;
  max: number | null;
}

interface CommandSpec {
  name: string;
  summary: string;
  positionals?: PositionalSpec;
  options?: readonly OptionSpec[];
  subcommands?: readonly CommandSpec[];
  missingArgumentHint?: string | null;
  isPassthrough?: boolean;
}

type ParsedValues = Record<string, string | boolean | undefined>;

type ParsedCommand =
  | { kind: 'help'; text: string }
  | { kind: 'refused'; text: string }
  | { kind: 'run'; commandPath: string[]; values: ParsedValues; positionals: string[]; rawArgs: string[] };

function padColumn(label: string): string {
  return `  ${label.padEnd(Math.max(USAGE_COLUMN_WIDTH, label.length + 1))}`;
}

function commandLabel(commandPath: readonly string[]): string {
  return [PROGRAM_NAME, ...commandPath].join(' ');
}

function usageLine(spec: CommandSpec, commandPath: readonly string[]): string {
  if (spec.subcommands) return `Usage: ${commandLabel(commandPath)} <command>`;
  const positionalUsage = spec.positionals ? ` ${spec.positionals.usage}` : '';
  return `Usage: ${commandLabel(commandPath)}${positionalUsage}`;
}

function optionLabel(option: OptionSpec): string {
  const shortLabel = option.short ? `, -${option.short}` : '';
  const valueLabel = option.type === 'string' ? ` <${option.valueName ?? 'value'}>` : '';
  return `--${option.name}${valueLabel}${shortLabel}`;
}

function subcommandLine(subcommand: CommandSpec): string {
  const positionalUsage = subcommand.positionals ? ` ${subcommand.positionals.usage}` : '';
  return `${padColumn(`${subcommand.name}${positionalUsage}`)}${subcommand.summary}`;
}

function renderHelp(spec: CommandSpec, commandPath: readonly string[]): string {
  const sections = [usageLine(spec, commandPath), spec.summary];
  if (spec.subcommands) {
    sections.push(['Commands:', ...spec.subcommands.map(subcommandLine)].join('\n'));
    sections.push(`Run "${commandLabel(commandPath)} <command> --help" for a command's options.`);
    return sections.join('\n\n');
  }
  const options = [...(spec.options ?? []), HELP_OPTION];
  sections.push(['Options:', ...options.map((option) => `${padColumn(optionLabel(option))}${option.summary}`)].join('\n'));
  return sections.join('\n\n');
}

function refusal(spec: CommandSpec, commandPath: readonly string[], reason: string): ParsedCommand {
  return { kind: 'refused', text: `${commandLabel(commandPath)}: ${reason}\n${usageLine(spec, commandPath)}` };
}

function parseOptionsConfig(spec: CommandSpec): Record<string, { type: 'boolean' | 'string'; short?: string }> {
  const options = [...(spec.options ?? []), HELP_OPTION];
  return Object.fromEntries(options.map((option) => [option.name, option.short ? { type: option.type, short: option.short } : { type: option.type }]));
}

function firstUnknownOption(spec: CommandSpec, args: readonly string[]): string | null {
  const declared = parseOptionsConfig(spec);
  const { tokens } = parseArgs({ args: [...args], options: declared, strict: false, allowPositionals: true, tokens: true });
  const unknown = tokens.find((token) => token.kind === 'option' && !(token.name in declared));
  if (unknown?.kind !== 'option') return null;
  return unknown.rawName;
}

function hasHelpBeforeTerminator(args: readonly string[]): boolean {
  const terminatorIndex = args.indexOf('--');
  const flagArguments = terminatorIndex === -1 ? args : args.slice(0, terminatorIndex);
  return flagArguments.includes('--help') || flagArguments.includes('-h');
}

function positionalCountProblem(spec: CommandSpec, positionals: readonly string[]): string | null {
  const bounds = spec.positionals ?? { usage: '', min: 0, max: 0 };
  if (positionals.length < bounds.min) return spec.missingArgumentHint ?? `this command needs ${bounds.usage}`;
  if (bounds.max === null || positionals.length <= bounds.max) return null;
  const extraWords = positionals.slice(bounds.max).join(' ');
  if (bounds.max === 0) return `this command takes no arguments, so ${extraWords} is not understood`;
  return `this command takes ${bounds.usage}, so ${extraWords} is not understood`;
}

function strictlyParse(spec: CommandSpec, args: readonly string[]): { values: ParsedValues; positionals: string[] } | { error: string } {
  try {
    return parseArgs({ args: [...args], options: parseOptionsConfig(spec), strict: true, allowPositionals: true });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function parseLeaf(spec: CommandSpec, args: readonly string[], commandPath: string[]): ParsedCommand {
  if (hasHelpBeforeTerminator(args)) return { kind: 'help', text: renderHelp(spec, commandPath) };
  const unknownOption = firstUnknownOption(spec, args);
  if (unknownOption) return refusal(spec, commandPath, `unknown option ${unknownOption}. Quote text that starts with a dash, or put it after --.`);
  const parsed = strictlyParse(spec, args);
  if ('error' in parsed) return refusal(spec, commandPath, parsed.error);
  const countProblem = positionalCountProblem(spec, parsed.positionals);
  if (countProblem) return refusal(spec, commandPath, countProblem);
  return { kind: 'run', commandPath, values: parsed.values, positionals: parsed.positionals, rawArgs: [...args] };
}

function parseCommand(spec: CommandSpec, args: readonly string[], commandPath: string[] = [spec.name]): ParsedCommand {
  if (spec.isPassthrough) return { kind: 'run', commandPath, values: {}, positionals: [...args], rawArgs: [...args] };
  if (!spec.subcommands) return parseLeaf(spec, args, commandPath);
  const [subcommandName, ...rest] = args;
  if (subcommandName === undefined) return { kind: 'refused', text: `${commandLabel(commandPath)}: this command needs a subcommand\n\n${renderHelp(spec, commandPath)}` };
  if (subcommandName === '--help' || subcommandName === '-h') return { kind: 'help', text: renderHelp(spec, commandPath) };
  const subcommand = spec.subcommands.find((candidate) => candidate.name === subcommandName);
  if (!subcommand) return { kind: 'refused', text: `${commandLabel(commandPath)}: unknown command ${subcommandName}\n\n${renderHelp(spec, commandPath)}` };
  return parseCommand(subcommand, rest, [...commandPath, subcommand.name]);
}

function renderOverviewLine(usage: string, summary: string): string {
  return `${padColumn(usage)}${summary}`;
}

export { parseCommand, renderHelp, renderOverviewLine };
export type { CommandSpec, OptionSpec, ParsedCommand, ParsedValues, PositionalSpec };
