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
  notes?: string;
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
  }
  if (!spec.subcommands) {
    const options = [...(spec.options ?? []), HELP_OPTION];
    sections.push(['Options:', ...options.map((option) => `${padColumn(optionLabel(option))}${option.summary}`)].join('\n'));
  }
  if (spec.notes) sections.push(spec.notes);
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

function unknownOptionReason(spec: CommandSpec, commandPath: readonly string[], unknownOption: string): string {
  const takesText = spec.positionals !== undefined && spec.positionals.max !== 0;
  if (!takesText) return `unknown option ${unknownOption}`;
  return `unknown option ${unknownOption}. Text that starts with a dash goes after --, as in ${commandLabel(commandPath)} -- ${unknownOption}`;
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
  if (unknownOption) return refusal(spec, commandPath, unknownOptionReason(spec, commandPath, unknownOption));
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

const CONFIG_OPTION: OptionSpec = { name: 'config', type: 'string', valueName: 'path', summary: 'Config file (default: ~/.glimmervoid/config.json)' };
const PORT_OPTION: OptionSpec = { name: 'port', type: 'string', valueName: 'number', summary: 'Server port (default: 3000)' };
const JSON_OPTION: OptionSpec = { name: 'json', type: 'boolean', summary: 'Machine-readable output' };
const SETTING_PATH = { usage: '<path>', min: 1, max: 1 };
const PACK_FOLDER = { usage: '<folder>', min: 1, max: 1 };
const PACK_NAME = { usage: '<name>', min: 1, max: 1 };
const PACK_SOURCE_URL = { usage: '<https-git-url>', min: 1, max: 1 };
const OPTIONAL_PACK_SOURCE_URL = { usage: '[https-git-url]', min: 0, max: 1 };

const SETTINGS_NOTES = `<path> is a config.json key path such as posthog.trafficSpikeEnabled, or a setting id such as posthog-traffic-enabled.
<value> is true or false for a toggle, a number, text, a comma-separated or JSON list, or JSON for a structured value.
A number is in the unit config.json stores, as schema's Stored unit column names: set branchGc.intervalMs 21600000 means 21600000 ms.
Where the dashboard shows another unit, get, list and set add it in parentheses, such as 30000 (30 seconds).
A secret (a bot token or API key) is never set or unset here, since a value on the command line lands in shell history;
change it in the dashboard settings or through its environment variable.`;

const OWNED_COMMAND_SPECS = {
  doctor: { name: 'doctor', summary: 'Check the install, PATH, agent CLIs and native module, then exit', options: [CONFIG_OPTION, PORT_OPTION] },
  pair: {
    name: 'pair',
    summary: 'Mint a single-use pairing link for a remote device, or list and revoke paired devices',
    options: [
      { name: 'name', type: 'string', valueName: 'label', summary: 'Name for the device being paired' },
      { name: 'list', type: 'boolean', summary: 'List paired devices' },
      { name: 'revoke', type: 'string', valueName: 'id', summary: 'Revoke a paired device' },
      CONFIG_OPTION,
      PORT_OPTION,
    ],
  },
  agent: {
    name: 'agent',
    summary: 'Set up an agent CLI to report to Glimmervoid',
    subcommands: [{
      name: 'setup',
      summary: 'Install an agent hook relay',
      subcommands: [{ name: 'grok', summary: 'Install the Grok hook relay, which does nothing outside Glimmervoid' }],
    }],
  },
  settings: {
    name: 'settings',
    summary: 'Read and change config.json from the command line',
    notes: SETTINGS_NOTES,
    subcommands: [
      { name: 'list', summary: 'Every config.json setting with its value and where the value comes from', options: [JSON_OPTION] },
      { name: 'get', summary: 'One setting; a secret shows as configured or not configured, never its value', positionals: SETTING_PATH, options: [JSON_OPTION] },
      { name: 'set', summary: 'Validate the whole file and write it; a running Glimmervoid reloads it. --file replaces each top-level key the file names in one write', positionals: { usage: '<path> <value> | --file <file>', min: 0, max: 2 }, options: [{ name: 'file', type: 'string', valueName: 'file', summary: 'JSON object of top-level keys to replace; secrets are kept and never taken' }, JSON_OPTION] },
      { name: 'export', summary: 'config.json as JSON with every secret removed, in the shape set --file takes' },
      { name: 'unset', summary: 'Remove the key from config.json so the default applies', positionals: SETTING_PATH, options: [JSON_OPTION] },
      { name: 'describe', summary: 'One setting: what it does, its default and, for a structured value, its JSON Schema and an example (needs no config file)', positionals: SETTING_PATH, options: [JSON_OPTION] },
      { name: 'search', summary: 'Find settings by title, keyword, key path or section', positionals: { usage: '<text>', min: 1, max: null }, options: [JSON_OPTION] },
      { name: 'schema', summary: 'Every setting: id, path, type, default, unit, effect and section (needs no config file)', options: [JSON_OPTION] },
    ],
  },
  'pr-flows': {
    name: 'pr-flows',
    summary: 'Check the PR flows sources, actions, PR actions and rules in config.json and its packs',
    subcommands: [{
      name: 'check',
      summary: 'Name each entry valid or its error, run each source once against --pr and print each action\'s expanded command without running it',
      options: [
        { name: 'pr', type: 'string', valueName: 'url', summary: 'A pull request URL to run the sources against' },
        JSON_OPTION, CONFIG_OPTION,
      ],
    }],
  },
  'github-usage': { name: 'github-usage', summary: 'Show the GitHub API calls and rate-limit points Glimmervoid spent in the last hour beside the account pool', options: [JSON_OPTION] },
  'pr-action': {
    name: 'pr-action',
    summary: 'Report the outcome of the PR action run that started this process',
    subcommands: [{
      name: 'report',
      summary: 'Set the run to started, done, failed or refused; the first final outcome wins',
      options: [
        { name: 'outcome', type: 'string', valueName: 'outcome', summary: 'started, done, failed or refused, shown beside the button' },
        { name: 'message', type: 'string', valueName: 'text', summary: 'Up to 500 characters shown after the outcome; an https link stays clickable' },
      ],
    }],
  },
  packs: {
    name: 'packs',
    summary: 'Build a Glimmervoid pack: read the guide, check, preview and install a pack folder, ask the operator to approve it, list and remove installed packs, add and update shared pack sources',
    subcommands: [
      { name: 'guide', summary: 'How to build a pack: its rules, the workflow and example packs to copy; --schema prints a JSON Schema', options: [{ name: 'schema', type: 'string', valueName: 'pack|bridge|actions|pr-flows', summary: 'Print only the pack.json (pack), panel bridge (bridge), panel action request (actions) or prFlows command output (pr-flows) JSON Schema' }] },
      { name: 'check', summary: 'Check a pack folder as Glimmervoid loads it, and every file its pages load; exits 1 on any problem', positionals: PACK_FOLDER, options: [JSON_OPTION], missingArgumentHint: 'check needs a pack folder, for example "glimmervoid packs check ./my-pack"' },
      {
        name: 'preview',
        summary: "Serve a pack folder's panels on 127.0.0.1 with sample data and its themes, re-reading the pack on every page load, until Ctrl-C",
        positionals: PACK_FOLDER,
        options: [{ name: 'port', type: 'string', valueName: 'number', summary: 'Port to serve on (default: any free port)' }],
        missingArgumentHint: 'preview needs a pack folder, for example "glimmervoid packs preview ./my-pack"',
      },
      { name: 'list', summary: 'The packs the running Glimmervoid found and whether each is approved; works inside a Glimmervoid session' },
      { name: 'install', summary: 'Check a pack folder and copy it into the packs folder, where it waits for the operator to approve it; installing again replaces the copy; works inside a Glimmervoid session', positionals: PACK_FOLDER, missingArgumentHint: 'install needs a pack folder, for example "glimmervoid packs install ./my-pack"' },
      { name: 'status', summary: "One pack's approval state, load errors and anything missing on this machine; works inside a Glimmervoid session", positionals: PACK_NAME, missingArgumentHint: 'status needs a pack name, for example "glimmervoid packs status my-pack"' },
      { name: 'request-approval', summary: 'Ask the operator to approve an installed pack in the Packs tab; works inside a Glimmervoid session', positionals: PACK_NAME, missingArgumentHint: 'request-approval needs a pack name, for example "glimmervoid packs request-approval my-pack"' },
      { name: 'remove', summary: 'Delete a pack that install placed; a pack placed by hand stays; works inside a Glimmervoid session', positionals: PACK_NAME, missingArgumentHint: 'remove needs a pack name, for example "glimmervoid packs remove my-pack"' },
      { name: 'add', summary: 'Clone a git repository of shared packs as a pack source; each pack stays off until the operator enables it in the Packs tab; works inside a Glimmervoid session', positionals: PACK_SOURCE_URL, missingArgumentHint: 'add needs the https URL of a git repository, for example "glimmervoid packs add https://github.com/owner/packs"' },
      { name: 'update', summary: 'Pull every pack source, or the one given, and reinstall its enabled packs, which wait for approval again when changed; works inside a Glimmervoid session', positionals: OPTIONAL_PACK_SOURCE_URL },
    ],
  },
  doorman: {
    name: 'doorman',
    summary: "Run the doorman: forward each tenant's traffic to its server, wake a sleeping server first, and run each tenant's watcher",
    options: [
      { name: 'tenants', type: 'string', valueName: 'path', summary: 'The tenant table file, reloaded when it changes; the doorman stops when it is deleted' },
      { name: 'state', type: 'string', valueName: 'gs://bucket', summary: 'The Cloud Storage bucket holding the tenant table, awake ledgers and watcher homes, in place of --tenants' },
      { name: 'port', type: 'string', valueName: 'number', summary: 'The loopback port to listen on (default: any free port)' },
    ],
  },
  'ssh-sign': { name: 'ssh-sign', summary: "Sign a commit with the operator's forwarded ssh agent (git runs this)", isPassthrough: true },
  'git-credential': { name: 'git-credential', summary: 'Give git the GitHub token of the connected GitHub user (git runs this)', isPassthrough: true },
} as const satisfies Record<string, CommandSpec>;

type OwnedCommandName = keyof typeof OWNED_COMMAND_SPECS;

function isOwnedCommandName(name: string): name is OwnedCommandName {
  return Object.hasOwn(OWNED_COMMAND_SPECS, name);
}

function renderOverviewLine(usage: string, summary: string): string {
  return `${padColumn(usage)}${summary}`;
}

export { OWNED_COMMAND_SPECS, isOwnedCommandName, parseCommand, renderOverviewLine };
export type { CommandSpec, OptionSpec, OwnedCommandName, ParsedCommand, PositionalSpec };
