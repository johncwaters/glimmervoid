import { shellQuote } from './hook-command-core.ts';

const CLAUDE_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
export const CLAUDE_TOKEN_ALIAS_ENV = 'GV_CLAUDE_TOKEN';
export const CODER_SSH_ENV = 'CODER_SSH_ENV';

const WORKSPACE_NAME_PREFIX = 'gv-';
const WORKSPACE_NAME_HEX_LENGTH = 12;
const WORKSPACE_NAME_RE = /^gv-[0-9a-f]{12}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LINE_BREAK_RE = /[\r\n]/;
const NUL_RE = /\0/;

interface TokenAlias {
  target: string;
  alias: string;
}

interface RemoteLaunchScript {
  workingDirectory: string;
  argv: readonly string[];
  tokenAliases?: readonly TokenAlias[];
}

interface CoderSshArgs {
  workspace: string;
  remotePort: number;
  ingressPort: number;
  remoteCommand: string;
}

interface CoderCreateArgs {
  workspace: string;
  template: string;
  stopAfter: string;
  parameters?: Readonly<Record<string, string>>;
}

export const CLAUDE_TOKEN_ALIASES: readonly TokenAlias[] = Object.freeze([{ target: CLAUDE_TOKEN_ENV, alias: CLAUDE_TOKEN_ALIAS_ENV }]);

export function workspaceNameFromHex(randomHex: string): string | null {
  const lowered = randomHex.toLowerCase();
  if (lowered.length !== WORKSPACE_NAME_HEX_LENGTH) return null;
  const candidate = `${WORKSPACE_NAME_PREFIX}${lowered}`;
  return WORKSPACE_NAME_RE.test(candidate) ? candidate : null;
}

function isGlimmervoidWorkspaceName(name: string): boolean {
  return WORKSPACE_NAME_RE.test(name);
}

export function remoteShellCommand(argv: readonly string[]): string | null {
  if (argv.length === 0) return null;
  if (argv.some((argument) => NUL_RE.test(argument))) return null;
  return argv.map(shellQuote).join(' ');
}

function tokenAliasPreamble(tokenAliases: readonly TokenAlias[]): string | null {
  const isEveryNameSafe = tokenAliases.every(({ target, alias }) => ENV_KEY_RE.test(target) && ENV_KEY_RE.test(alias));
  if (!isEveryNameSafe) return null;
  return tokenAliases.map(({ target, alias }) => `export ${target}="$${alias}"; unset ${alias}; `).join('');
}

export function remoteLaunchScript({ workingDirectory, argv, tokenAliases = [] }: RemoteLaunchScript): string | null {
  const agentCommand = remoteShellCommand(argv);
  if (agentCommand === null) return null;
  if (workingDirectory === '' || NUL_RE.test(workingDirectory)) return null;
  const preamble = tokenAliasPreamble(tokenAliases);
  if (preamble === null) return null;
  return `${preamble}cd ${shellQuote(workingDirectory)} && exec ${agentCommand}`;
}

function csvField(field: string): string {
  return `"${field.replace(/"/g, '""')}"`;
}

export function encodeCoderSshEnv(env: Readonly<Record<string, string>>): string | null {
  const fields: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(key)) return null;
    if (LINE_BREAK_RE.test(value) || NUL_RE.test(value)) return null;
    fields.push(csvField(`${key}=${value}`));
  }
  return fields.join(',');
}

function isPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

export function coderSshArgs({ workspace, remotePort, ingressPort, remoteCommand }: CoderSshArgs): string[] | null {
  if (!isGlimmervoidWorkspaceName(workspace)) return null;
  if (!isPort(remotePort) || !isPort(ingressPort)) return null;
  return ['ssh', workspace, '--tty', '--remote-forward', `${remotePort}:127.0.0.1:${ingressPort}`, '--wait', 'no', '--', remoteCommand];
}

export function coderCreateArgs({ workspace, template, stopAfter, parameters = {} }: CoderCreateArgs): string[] | null {
  if (!isGlimmervoidWorkspaceName(workspace)) return null;
  if (template === '' || template.startsWith('-')) return null;
  const parameterArgs: string[] = [];
  for (const [name, value] of Object.entries(parameters)) {
    if (name === '' || name.includes('=') || name.startsWith('-')) return null;
    if (LINE_BREAK_RE.test(value) || NUL_RE.test(value)) return null;
    parameterArgs.push('--parameter', csvField(`${name}=${value}`));
  }
  return ['create', workspace, '--template', template, '--preset', 'none', '--stop-after', stopAfter, ...parameterArgs, '--yes'];
}
