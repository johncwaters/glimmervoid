import path from 'node:path';
import { PackSettingsFile } from '../../shared/contracts/pack.ts';
import type { PackOnDisk, PackSetting } from '../../shared/contracts/pack.ts';
import { packVaultName } from '../../shared/contracts/secrets.ts';
import { settingReachesCommand } from '../../shared/contracts/pack-bridge.ts';
import type { SecretName, SecretSource } from '../../shared/contracts/secrets.ts';
import type { PackSettingsView } from '../../shared/contracts/control/pack-messages.ts';
import { clock } from '../../shared/clock.ts';
import { errorMessage } from '../../shared/text.ts';
import { loadJsonStateFile, writeTextAtomic } from '../json-file.ts';
import { createKeyedSerialQueue } from '../spawn-gate.ts';
import type { ReadOutcome, SaveFailure } from '../secrets/core/fnox-core.ts';
import { missingSettingKeys, packCommandEnv, packSettingsOf, secretSettingKeysFor } from './core/pack-core.ts';

const PACK_SETTINGS_FILE_NAME = 'pack-settings.json';
const SECRET_CACHE_MS = 10 * 60 * 1000;
const PRIVATE_FILE_MODE = 0o600;

export type PackVault = {
  source: () => SecretSource | null;
  read: (source: SecretSource, name: SecretName) => Promise<ReadOutcome>;
  saveToAgeFile: (name: SecretName, value: string) => Promise<SaveFailure | null>;
};

type SecretRead = { state: 'found'; value: string } | { state: 'missing' } | { state: 'unreadable'; reason: string };
type FileRead = { ok: true; file: PackSettingsFile } | { ok: false; error: string };
export type PackCommandSettings = { env: Record<string, string>; secretValues: string[]; missingKeys: string[]; unreadable: string | null };
type SaveOutcome = { ok: true } | { ok: false; error: string };
type ViewOutcome = { ok: true; settings: PackSettingsView } | { ok: false; error: string };

export function createPackSettings({ homeDir, vault, approvedPack, now = clock.nowMs }: {
  homeDir: string;
  vault: PackVault;
  approvedPack: (packName: string) => PackOnDisk | null;
  now?: () => number;
}) {
  const filePath = path.join(homeDir, PACK_SETTINGS_FILE_NAME);
  const writes = createKeyedSerialQueue();
  const cachedSecrets = new Map<string, { read: SecretRead; readAtMs: number }>();

  async function readFile(): Promise<FileRead> {
    const outcome = await loadJsonStateFile({ filePath, parse: (raw) => PackSettingsFile.safeParse(raw).data ?? null });
    if (outcome.status === 'loaded') return { ok: true, file: outcome.value };
    if (outcome.status === 'missing') return { ok: true, file: { version: 1, valuesByPack: {} } };
    if (outcome.status === 'quarantined') return { ok: false, error: `${filePath} was not valid pack settings and was set aside; save the settings again` };
    return { ok: false, error: `${filePath} could not be read: ${errorMessage(outcome.error)}` };
  }

  async function plainValuesOf(packName: string): Promise<{ ok: true; values: Record<string, string> } | { ok: false; error: string }> {
    const read = await readFile();
    return read.ok ? { ok: true, values: read.file.valuesByPack[packName] ?? {} } : read;
  }

  function remember(vaultName: SecretName, read: SecretRead): SecretRead {
    cachedSecrets.set(vaultName, { read, readAtMs: now() });
    return read;
  }

  async function secretOf(vaultName: SecretName): Promise<SecretRead> {
    const cached = cachedSecrets.get(vaultName);
    if (cached !== undefined && now() - cached.readAtMs < SECRET_CACHE_MS) return cached.read;
    const source = vault.source();
    if (source === null) return { state: 'unreadable', reason: 'no vault is set up in Settings' };
    const outcome = await vault.read(source, vaultName).catch((error: unknown) => ({ failure: { kind: 'unavailable' as const, message: errorMessage(error), detail: '' } }));
    if ('value' in outcome && outcome.value !== '') return remember(vaultName, { state: 'found', value: outcome.value });
    if ('value' in outcome || outcome.failure.kind === 'not-found') return remember(vaultName, { state: 'missing' });
    return { state: 'unreadable', reason: outcome.failure.message };
  }

  async function secretsByKey(packName: string, keys: readonly SecretName[]): Promise<Map<string, SecretRead>> {
    const readsByKey = new Map<string, SecretRead>();
    for (const key of keys) readsByKey.set(key, await secretOf(packVaultName(packName, key)));
    return readsByKey;
  }

  function foundValues(readsByKey: ReadonlyMap<string, SecretRead>): Record<string, string> {
    return Object.fromEntries([...readsByKey].flatMap(([key, read]) => (read.state === 'found' ? [[key, read.value]] : [])));
  }

  function secretKeysOf(settings: readonly PackSetting[]): SecretName[] {
    return settings.filter((setting) => setting.kind === 'secret').map((setting) => setting.key);
  }

  async function view(packName: string): Promise<ViewOutcome> {
    const pack = approvedPack(packName);
    if (pack === null) return { ok: false, error: `${packName} is not an approved pack` };
    const settings = packSettingsOf(pack);
    const plain = await plainValuesOf(packName);
    if (!plain.ok) return plain;
    const readsByKey = await secretsByKey(packName, secretKeysOf(settings));
    const textKeys = new Set(settings.filter((setting) => setting.kind === 'text').map((setting) => setting.key));
    return {
      ok: true,
      settings: {
        manager: vault.source()?.manager ?? null,
        valuesByKey: Object.fromEntries(Object.entries(plain.values).filter(([key]) => textKeys.has(key))),
        secretStateByKey: Object.fromEntries([...readsByKey].map(([key, read]) => [key, read.state])),
        vaultNameByKey: Object.fromEntries(secretKeysOf(settings).map((key) => [key, packVaultName(packName, key)])),
        missingKeys: missingSettingKeys(settings, plain.values, new Set(Object.keys(foundValues(readsByKey)))),
      },
    };
  }

  async function saveSecret(packName: string, key: SecretName, value: string): Promise<string | null> {
    const vaultName = packVaultName(packName, key);
    const manager = vault.source()?.manager ?? null;
    if (manager === null) return `no vault is set up in Settings, so ${vaultName} has nowhere to go`;
    if (manager !== 'age') return `${vaultName} is read from 1Password, which Glimmervoid never writes; create it there`;
    const failure = await vault.saveToAgeFile(vaultName, value);
    if (failure !== null) return `${vaultName} could not be saved to the vault: ${failure.message}`;
    cachedSecrets.delete(vaultName);
    return null;
  }

  async function savePlainValues(packName: string, settings: readonly PackSetting[], valuesByKey: Readonly<Record<string, string>>): Promise<SaveOutcome> {
    return writes.run(filePath, async (): Promise<SaveOutcome> => {
      const current = await readFile();
      if (!current.ok) return current;
      const currentPlain = current.file.valuesByPack[packName] ?? {};
      const textKeys = settings.filter((setting) => setting.kind === 'text').map((setting) => setting.key);
      const nextPlain = Object.fromEntries(textKeys.map((key) => [key, (valuesByKey[key] ?? currentPlain[key] ?? '').trim()]).filter(([, value]) => value !== ''));
      const next: PackSettingsFile = { version: 1, valuesByPack: { ...current.file.valuesByPack, [packName]: nextPlain } };
      try {
        await writeTextAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`, { mkdir: true, mode: PRIVATE_FILE_MODE });
      } catch (error) {
        return { ok: false, error: `${filePath} could not be written: ${errorMessage(error)}` };
      }
      return { ok: true };
    });
  }

  async function save(packName: string, valuesByKey: Readonly<Record<string, string>>): Promise<SaveOutcome> {
    const pack = approvedPack(packName);
    if (pack === null) return { ok: false, error: `${packName} is not an approved pack` };
    const settings = packSettingsOf(pack);
    const undeclaredKey = Object.keys(valuesByKey).find((key) => !settings.some((setting) => setting.key === key));
    if (undeclaredKey !== undefined) return { ok: false, error: `${packName} declares no setting ${undeclaredKey}` };
    const plainSaved = await savePlainValues(packName, settings, valuesByKey);
    if (!plainSaved.ok) return plainSaved;
    for (const key of secretKeysOf(settings)) {
      const value = valuesByKey[key] ?? '';
      if (value === '') continue;
      const failure = await saveSecret(packName, key, value);
      if (failure !== null) return { ok: false, error: `The text settings were saved, but ${failure}` };
    }
    return { ok: true };
  }

  function unreadableText(plainError: string | null, readsByKey: ReadonlyMap<string, SecretRead>): string | null {
    if (plainError !== null) return plainError;
    for (const [key, read] of readsByKey) {
      if (read.state === 'unreadable') return `${key} could not be read from the vault: ${read.reason}`;
    }
    return null;
  }

  async function commandSettings(pack: PackOnDisk, commandRef: string): Promise<PackCommandSettings> {
    const settings = packSettingsOf(pack);
    const plain = await plainValuesOf(pack.header.name);
    const plainValues = plain.ok ? plain.values : {};
    const commandSecretKeys = secretSettingKeysFor(settings, commandRef);
    const readsByKey = await secretsByKey(pack.header.name, commandSecretKeys);
    const secretValues = foundValues(readsByKey);
    const relevantSettings = settings.filter((setting) => settingReachesCommand(setting, commandRef));
    return {
      env: packCommandEnv(settings, commandRef, plainValues, secretValues),
      secretValues: Object.values(secretValues),
      missingKeys: missingSettingKeys(relevantSettings, plainValues, new Set(Object.keys(secretValues))),
      unreadable: unreadableText(plain.ok ? null : plain.error, readsByKey),
    };
  }

  return { view, save, commandSettings };
}

export type PackSettingsStore = ReturnType<typeof createPackSettings>;
