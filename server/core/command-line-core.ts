import { parseArgs } from 'node:util';

type GlobalOptions = {
  configPath: string | null;
  port: string | null;
};

type ParsedCommandLine =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'refused'; text: string }
  | { kind: 'server'; globalOptions: GlobalOptions; isBrowserOpenSkipped: boolean }
  | { kind: 'subcommand'; name: string; subcommandArgs: string[]; globalOptions: GlobalOptions };

const GLOBAL_OPTIONS = {
  config: { type: 'string' },
  port: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  doctor: { type: 'boolean' },
  'no-open': { type: 'boolean' },
} as const;

function commandNameIndex(argv: readonly string[]): number {
  const { tokens } = parseArgs({ args: [...argv], options: GLOBAL_OPTIONS, strict: false, allowPositionals: true, tokens: true });
  const firstPositional = tokens.find((token) => token.kind === 'positional');
  return firstPositional ? firstPositional.index : argv.length;
}

type GlobalValues = { config?: string; port?: string; help?: boolean; version?: boolean; doctor?: boolean; 'no-open'?: boolean };

function parseGlobalValues(leadingArgs: string[]): { ok: true; values: GlobalValues } | { ok: false; text: string } {
  try {
    return { ok: true, values: parseArgs({ args: leadingArgs, options: GLOBAL_OPTIONS, strict: true, allowPositionals: false }).values };
  } catch (error) {
    return { ok: false, text: `glimmervoid: ${error instanceof Error ? error.message : String(error)}\nRun glimmervoid --help for the commands and options.` };
  }
}

function parseCommandLine(argv: readonly string[]): ParsedCommandLine {
  const nameIndex = commandNameIndex(argv);
  const parsedGlobals = parseGlobalValues(argv.slice(0, nameIndex));
  if (!parsedGlobals.ok) return { kind: 'refused', text: parsedGlobals.text };
  const { values } = parsedGlobals;
  const name = argv[nameIndex];
  const subcommandArgs = argv.slice(nameIndex + 1);
  if (values.help) return { kind: 'help' };
  if (values.version) return { kind: 'version' };
  const globalOptions = { configPath: values.config ?? null, port: values.port ?? null };
  if (values.doctor) return { kind: 'subcommand', name: 'doctor', subcommandArgs: [], globalOptions };
  if (name === undefined) return { kind: 'server', globalOptions, isBrowserOpenSkipped: values['no-open'] === true };
  return { kind: 'subcommand', name, subcommandArgs, globalOptions };
}

export { parseCommandLine };
