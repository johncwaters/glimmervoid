import type { SecretManager, SecretName, SecretSource } from '../../../shared/contracts/secrets.ts';

type ReadFailureKind = 'not-found' | 'refused' | 'timed-out' | 'unavailable';

interface ReadFailure {
  kind: ReadFailureKind;
  message: string;
  detail: string;
}

type ReadOutcome = { value: string } | { failure: ReadFailure };

type TestOutcome = { ok: true } | { ok: false; message: string; detail: string };

interface FnoxRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  failureCode: string | null;
  wasKilled: boolean;
}

interface ProviderFields {
  label: string;
  type: string;
  lookInKey: string;
}

const PROVIDER_FIELDS_BY_MANAGER: Record<SecretManager, ProviderFields> = {
  '1password': { label: '1Password', type: '1password', lookInKey: 'vault' },
};

const FNOX_PROVIDER_NAME = 'source';
const MAX_DETAIL_LENGTH = 4000;
const NOT_FOUND_MARKERS = ['fnox::secret::not_found', "isn't an item", "isn't a vault", 'does not have a field', 'no item'];
const REFUSED_MARKERS = ['dismissed', 'denied', 'not authorized', 'cancel'];
const TERMINAL_ESCAPES = new RegExp(`${String.fromCharCode(27)}(\\[[0-9;?]*[A-Za-z]|\\][^${String.fromCharCode(7)}${String.fromCharCode(27)}]*(${String.fromCharCode(7)}|${String.fromCharCode(27)}\\\\))`, 'g');

function tomlString(text: string): string {
  return JSON.stringify(text);
}

function fnoxConfigText(source: SecretSource, name: SecretName | null): string {
  const provider = PROVIDER_FIELDS_BY_MANAGER[source.manager];
  const providerLines = [
    `[providers.${FNOX_PROVIDER_NAME}]`,
    `type = ${tomlString(provider.type)}`,
    `${provider.lookInKey} = ${tomlString(source.lookIn)}`,
  ];
  if (name === null) return `${providerLines.join('\n')}\n`;
  const secretLines = ['[secrets]', `${name} = { provider = ${tomlString(FNOX_PROVIDER_NAME)}, value = ${tomlString(name)} }`];
  return `${providerLines.join('\n')}\n\n${secretLines.join('\n')}\n`;
}

function fnoxReadArguments(configPath: string, name: SecretName): string[] {
  return ['-c', configPath, '--no-daemon', '--non-interactive', '--if-missing', 'error', 'get', name];
}

function fnoxTestArguments(configPath: string): string[] {
  return ['-c', configPath, '--no-daemon', '--non-interactive', 'provider', 'test', FNOX_PROVIDER_NAME];
}

function fnoxEnvironment(baseEnvironment: NodeJS.ProcessEnv, emptyConfigDirectory: string): NodeJS.ProcessEnv {
  const keptEntries = Object.entries(baseEnvironment).filter(([key]) => !key.toUpperCase().startsWith('FNOX_'));
  return { ...Object.fromEntries(keptEntries), FNOX_CONFIG_DIR: emptyConfigDirectory };
}

function cleanDetail(stderr: string): string {
  return stderr.replace(TERMINAL_ESCAPES, '').trim().slice(0, MAX_DETAIL_LENGTH);
}

function withoutTrailingNewline(stdout: string): string {
  if (stdout.endsWith('\r\n')) return stdout.slice(0, -2);
  if (stdout.endsWith('\n')) return stdout.slice(0, -1);
  return stdout;
}

function includesAny(text: string, markers: readonly string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}

function failureOf(result: FnoxRunResult, source: SecretSource, name: SecretName): ReadFailure {
  const label = PROVIDER_FIELDS_BY_MANAGER[source.manager].label;
  const detail = cleanDetail(result.stderr);
  const lowerDetail = detail.replace(/[\s\u2502]+/g, ' ').toLowerCase();
  if (result.wasKilled) return { kind: 'timed-out', message: `${label} was not confirmed in time`, detail };
  if (result.failureCode !== null) return { kind: 'unavailable', message: `Glimmervoid could not start its ${label} reader (${result.failureCode})`, detail };
  if (lowerDetail.includes('fnox::provider::cli_not_found')) return { kind: 'unavailable', message: `${label} is not installed where Glimmervoid can run it`, detail };
  if (includesAny(lowerDetail, NOT_FOUND_MARKERS)) return { kind: 'not-found', message: `${label} has no item ${name} in ${source.lookIn}`, detail };
  if (includesAny(lowerDetail, REFUSED_MARKERS)) return { kind: 'refused', message: `${label} refused to read ${name}`, detail };
  return { kind: 'unavailable', message: `${label} could not read ${name}`, detail };
}

function readOutcomeOf(result: FnoxRunResult, source: SecretSource, name: SecretName): ReadOutcome {
  if (!result.ok) return { failure: failureOf(result, source, name) };
  const value = withoutTrailingNewline(result.stdout);
  if (value.length > 0) return { value };
  const label = PROVIDER_FIELDS_BY_MANAGER[source.manager].label;
  return { failure: { kind: 'not-found', message: `${label} holds an empty ${name} in ${source.lookIn}`, detail: cleanDetail(result.stderr) } };
}

function testOutcomeOf(result: FnoxRunResult, source: SecretSource): TestOutcome {
  if (result.ok) return { ok: true };
  const label = PROVIDER_FIELDS_BY_MANAGER[source.manager].label;
  const detail = cleanDetail(result.stderr);
  if (result.wasKilled) return { ok: false, message: `${label} did not answer in time`, detail };
  if (result.failureCode !== null) return { ok: false, message: `Glimmervoid could not start its ${label} reader (${result.failureCode})`, detail };
  return { ok: false, message: `${label} could not open ${source.lookIn}`, detail };
}

export { fnoxConfigText, fnoxEnvironment, fnoxReadArguments, fnoxTestArguments, readOutcomeOf, testOutcomeOf };
export type { FnoxRunResult, ReadOutcome, TestOutcome };
