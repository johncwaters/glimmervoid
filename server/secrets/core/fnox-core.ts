import { SECRET_MANAGER_LABELS } from '../../../shared/contracts/secrets.ts';
import { AGE_PROVIDER_NAME } from './age-key-core.ts';
import type { OnePasswordSource, SecretName, SecretSource, SecretSourceTestResult } from '../../../shared/contracts/secrets.ts';

type ReadFailureKind = 'not-found' | 'refused' | 'timed-out' | 'unavailable';

interface ReadFailure {
  kind: ReadFailureKind;
  message: string;
  detail: string;
}

type ReadOutcome = { value: string } | { failure: ReadFailure };

interface SaveFailure {
  message: string;
  detail: string;
}

interface FnoxRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  failureCode: string | null;
  wasKilled: boolean;
}

const FNOX_PROVIDER_NAME = 'source';
const MAX_DETAIL_LENGTH = 4000;
const NOT_FOUND_MARKERS = ['fnox::secret::not_found', "isn't an item", 'does not have a field', 'no item'];
const MISSING_VAULT_MARKERS = ["isn't a vault"];
const REFUSED_MARKERS = ['dismissed', 'denied', 'not authorized', 'cancel'];
const AGE_KEY_MISSING_MARKERS = ['fnox::encryption::age::identity_not_found', 'fnox::encryption::age::identity_read_failed'];
const TERMINAL_ESCAPES = new RegExp(`${String.fromCharCode(27)}(\\[[0-9;?]*[A-Za-z]|\\][^${String.fromCharCode(7)}${String.fromCharCode(27)}]*(${String.fromCharCode(7)}|${String.fromCharCode(27)}\\\\))`, 'g');

function tomlString(text: string): string {
  return JSON.stringify(text);
}

function fnoxConfigText(source: OnePasswordSource, name: SecretName | null): string {
  const providerLines = [
    `[providers.${FNOX_PROVIDER_NAME}]`,
    `type = ${tomlString('1password')}`,
    `vault = ${tomlString(source.lookIn)}`,
  ];
  if (name === null) return `${providerLines.join('\n')}\n`;
  const secretLines = ['[secrets]', `${name} = { provider = ${tomlString(FNOX_PROVIDER_NAME)}, value = ${tomlString(name)} }`];
  return `${providerLines.join('\n')}\n\n${secretLines.join('\n')}\n`;
}

function fnoxReadArguments(configPath: string, name: SecretName): string[] {
  return ['-c', configPath, '--no-daemon', '--non-interactive', '--if-missing', 'error', 'get', name];
}

function fnoxSaveArguments(storePath: string, name: SecretName): string[] {
  return ['-c', storePath, '--no-daemon', '--non-interactive', 'set', '--provider', AGE_PROVIDER_NAME, name];
}

function saveFailureOf(result: FnoxRunResult, name: SecretName): SaveFailure | null {
  if (result.ok) return null;
  const detail = cleanDetail(result.stderr);
  if (result.wasKilled) return { message: `Saving ${name} to the age file did not finish in time`, detail };
  if (result.failureCode !== null) return { message: `Glimmervoid could not start its age file writer (${result.failureCode})`, detail };
  return { message: `Glimmervoid could not save ${name} to the age file`, detail };
}

function fnoxTestArguments(configPath: string): string[] {
  return ['-c', configPath, '--no-daemon', '--non-interactive', 'provider', 'discover', FNOX_PROVIDER_NAME];
}

function fnoxEnvironment(baseEnvironment: NodeJS.ProcessEnv, emptyConfigDirectory: string): NodeJS.ProcessEnv {
  const keptEntries = Object.entries(baseEnvironment).filter(([key]) => !key.toUpperCase().startsWith('FNOX_'));
  return { ...Object.fromEntries(keptEntries), FNOX_CONFIG_DIR: emptyConfigDirectory };
}

function fnoxAgeEnvironment(baseEnvironment: NodeJS.ProcessEnv, emptyConfigDirectory: string, keyPath: string): NodeJS.ProcessEnv {
  return { ...fnoxEnvironment(baseEnvironment, emptyConfigDirectory), FNOX_AGE_KEY_FILE: keyPath };
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

function ageFailureOf(result: FnoxRunResult, name: SecretName): ReadFailure {
  const detail = cleanDetail(result.stderr);
  const lowerDetail = detail.replace(/[\s\u2502]+/g, ' ').toLowerCase();
  if (result.wasKilled) return { kind: 'timed-out', message: `Reading ${name} from the age file did not finish in time`, detail };
  if (result.failureCode !== null) return { kind: 'unavailable', message: `Glimmervoid could not start its age file reader (${result.failureCode})`, detail };
  if (includesAny(lowerDetail, AGE_KEY_MISSING_MARKERS)) return { kind: 'unavailable', message: `The age key is missing or unreadable, so Glimmervoid cannot read ${name}`, detail };
  if (lowerDetail.includes('fnox::secret::not_found')) return missingFromAgeFile(name, detail);
  return { kind: 'unavailable', message: `Glimmervoid could not read ${name} from the age file`, detail };
}

function missingFromAgeFile(name: SecretName, detail: string): ReadFailure {
  return { kind: 'not-found', message: `The age file has no ${name}`, detail };
}

function failureOf(result: FnoxRunResult, source: SecretSource, name: SecretName): ReadFailure {
  if (source.manager === 'age') return ageFailureOf(result, name);
  const label = SECRET_MANAGER_LABELS[source.manager];
  const detail = cleanDetail(result.stderr);
  const lowerDetail = detail.replace(/[\s\u2502]+/g, ' ').toLowerCase();
  if (result.wasKilled) return { kind: 'timed-out', message: `${label} was not confirmed in time`, detail };
  if (result.failureCode !== null) return { kind: 'unavailable', message: `Glimmervoid could not start its ${label} reader (${result.failureCode})`, detail };
  if (lowerDetail.includes('fnox::provider::cli_not_found')) return { kind: 'unavailable', message: `${label} is not installed where Glimmervoid can run it`, detail };
  if (includesAny(lowerDetail, MISSING_VAULT_MARKERS)) return { kind: 'not-found', message: `${label} has no vault ${source.lookIn}. Check Look in under Settings > Vault`, detail };
  if (includesAny(lowerDetail, NOT_FOUND_MARKERS)) return { kind: 'not-found', message: `${label} has no item ${name} in ${source.lookIn}`, detail };
  if (includesAny(lowerDetail, REFUSED_MARKERS)) return { kind: 'refused', message: `${label} refused to read ${name}`, detail };
  return { kind: 'unavailable', message: `${label} could not read ${name}`, detail };
}

function readOutcomeOf(result: FnoxRunResult, source: SecretSource, name: SecretName): ReadOutcome {
  if (!result.ok) return { failure: failureOf(result, source, name) };
  const value = withoutTrailingNewline(result.stdout);
  if (value.length > 0) return { value };
  if (source.manager === 'age') return { failure: { kind: 'not-found', message: `The age file holds an empty ${name}`, detail: cleanDetail(result.stderr) } };
  const label = SECRET_MANAGER_LABELS[source.manager];
  return { failure: { kind: 'not-found', message: `${label} holds an empty ${name} in ${source.lookIn}`, detail: cleanDetail(result.stderr) } };
}

function testOutcomeOf(result: FnoxRunResult, source: OnePasswordSource): SecretSourceTestResult {
  const label = SECRET_MANAGER_LABELS[source.manager];
  const detail = cleanDetail(result.stderr);
  const lowerDetail = detail.replace(/[\s\u2502]+/g, ' ').toLowerCase();
  if (result.ok) return { ok: true, message: `${label} opened the vault ${source.lookIn}`, detail: '' };
  if (result.wasKilled) return { ok: false, message: `${label} did not answer in time`, detail };
  if (result.failureCode !== null) return { ok: false, message: `Glimmervoid could not start its ${label} reader (${result.failureCode})`, detail };
  if (lowerDetail.includes('fnox::provider::cli_not_found')) return { ok: false, message: `${label} is not installed where Glimmervoid can run it`, detail };
  if (includesAny(lowerDetail, MISSING_VAULT_MARKERS)) return { ok: false, message: `${label} has no vault ${source.lookIn}. Check Look in`, detail };
  if (includesAny(lowerDetail, REFUSED_MARKERS)) return { ok: false, message: `${label} was not confirmed`, detail };
  return { ok: false, message: `${label} did not sign in`, detail };
}

export { fnoxAgeEnvironment, fnoxConfigText, fnoxEnvironment, missingFromAgeFile, fnoxReadArguments, fnoxSaveArguments, fnoxTestArguments, readOutcomeOf, saveFailureOf, testOutcomeOf };
export type { FnoxRunResult, ReadOutcome, SaveFailure };
