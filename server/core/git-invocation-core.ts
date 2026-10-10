import { buildFactoryCheckEnv } from './factory-core.ts';

export type GitIsolationOptions = { disableHooks?: boolean; disableRepoCommands?: boolean; replaceEnv?: Record<string, string> };

export const GIT_CONFIG_LISTING_ARGS = Object.freeze(['config', '--null', '--list', '--show-scope']);

const GIT_TRANSPORT_ENV_KEYS = Object.freeze([
  'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS', 'XDG_CONFIG_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
]);
const OPERATOR_CONFIG_SCOPES = new Set(['system', 'global']);
const REPOSITORY_CONFIG_SCOPES = new Set(['local', 'worktree']);
const CREDENTIAL_HELPER_KEY_PATTERN = /^credential\.(.+\.)?helper$/;
const SSH_COMMAND_KEY = 'core.sshcommand';

type ScopedConfigEntry = { scope: string; key: string; value: string | null };

function parseScopedConfigListing(configListing: string): ScopedConfigEntry[] {
  const fields = configListing.split('\0');
  const entries: ScopedConfigEntry[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const scope = fields[index];
    const keyAndValue = fields[index + 1];
    if (!scope || !keyAndValue) continue;
    const separatorIndex = keyAndValue.indexOf('\n');
    entries.push(separatorIndex === -1
      ? { scope, key: keyAndValue, value: null }
      : { scope, key: keyAndValue.slice(0, separatorIndex), value: keyAndValue.slice(separatorIndex + 1) });
  }
  return entries;
}

function operatorValues(entries: readonly ScopedConfigEntry[], key: string): string[] {
  return entries.filter((entry) => entry.key === key && OPERATOR_CONFIG_SCOPES.has(entry.scope)).map((entry) => entry.value ?? '');
}

function credentialHelperOverrides(entries: readonly ScopedConfigEntry[]): string[] {
  const helperKeys = new Set(entries.filter((entry) => CREDENTIAL_HELPER_KEY_PATTERN.test(entry.key)).map((entry) => entry.key));
  return [...helperKeys].flatMap((key) => [`${key}=`, ...operatorValues(entries, key).map((value) => `${key}=${value}`)]);
}

function sshCommandOverrides(entries: readonly ScopedConfigEntry[]): string[] {
  const isRepositorySet = entries.some((entry) => entry.key === SSH_COMMAND_KEY && REPOSITORY_CONFIG_SCOPES.has(entry.scope));
  if (!isRepositorySet) return [];
  return [`core.sshCommand=${operatorValues(entries, SSH_COMMAND_KEY).at(-1) ?? 'ssh'}`];
}

function transportEnv(baseEnv: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const passedThrough: Record<string, string> = {};
  for (const key of GIT_TRANSPORT_ENV_KEYS) {
    const value = baseEnv[key];
    if (value !== undefined) passedThrough[key] = value;
  }
  return passedThrough;
}

export function parseFilterDriverNames(checkAttrOutput: string): string[] {
  const fields = checkAttrOutput.split('\0');
  const driverNames = new Set<string>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const value = fields[index + 2];
    if (fields[index + 1] !== 'filter' || value === 'unspecified' || value === 'unset' || value === 'set' || value === '') continue;
    driverNames.add(value);
  }
  return [...driverNames].sort();
}

export function buildHardenedGitInvocation(args: string[], { baseEnv, transportSourceEnv = {}, platform, devNullPath, configListing = '' }: {
  baseEnv: Readonly<Record<string, string | undefined>>; transportSourceEnv?: Readonly<Record<string, string | undefined>>;
  platform: string; devNullPath: string; configListing?: string;
}): { args: string[]; env: Record<string, string> } {
  const overrides = [
    `core.hooksPath=${devNullPath}`, 'core.fsmonitor=false', 'core.untrackedCache=false', 'core.editor=true', 'sequence.editor=true',
    'diff.external=', 'merge.default=text', 'merge.renormalize=false', 'commit.gpgsign=false', 'tag.gpgsign=false', 'maintenance.auto=false', 'gc.auto=0',
  ];
  const configEntries = parseScopedConfigListing(configListing);
  for (const key of new Set(configEntries.map((entry) => entry.key))) {
    if (/^filter\..+\.(clean|smudge|process|required)$/.test(key)) overrides.push(`${key}=${key.endsWith('.required') ? 'false' : ''}`);
    if (/^diff\..+\.(command|textconv)$/.test(key)) overrides.push(`${key}=`);
    if (/^merge\..+\.driver$/.test(key)) overrides.push(`${key}=false`);
  }
  overrides.push(...credentialHelperOverrides(configEntries), ...sshCommandOverrides(configEntries));
  const commandIndex = args.findIndex((argument, index) => !argument.startsWith('-') && (index === 0 || args[index - 1] !== '-c'));
  const command = args[commandIndex];
  const commandArgs = [...args];
  if (command === 'diff' || command === 'show' || command === 'log') commandArgs.splice(commandIndex + 1, 0, '--no-ext-diff', '--no-textconv');
  return {
    args: [...overrides.flatMap((override) => ['-c', override]), ...commandArgs],
    env: { ...buildFactoryCheckEnv(baseEnv, platform), ...transportEnv(transportSourceEnv), ...transportEnv(baseEnv), GIT_TERMINAL_PROMPT: '0' },
  };
}

export function gitInvocationEnvironment(invocation: { args: string[]; env: Record<string, string> }): Record<string, string> {
  const gitEnvironment: Record<string, string> = { ...invocation.env, GIT_CONFIG_COUNT: String(invocation.args.length / 2) };
  for (let index = 0; index < invocation.args.length; index += 2) {
    const setting = invocation.args[index + 1];
    const separatorIndex = setting.indexOf('=');
    gitEnvironment[`GIT_CONFIG_KEY_${index / 2}`] = setting.slice(0, separatorIndex);
    gitEnvironment[`GIT_CONFIG_VALUE_${index / 2}`] = setting.slice(separatorIndex + 1);
  }
  return gitEnvironment;
}
