import { isRecord } from '../../shared/coerce.ts';

interface EnvSecretBinding {
  blockName: string;
  secretKey: string;
  environmentVariable: string;
  isEnvironmentOnly: boolean;
}

interface ResolvedEnvSecret extends EnvSecretBinding {
  value: string;
}

type ConfigBlocks = Record<string, unknown>;

const ENV_SECRET_BINDINGS: readonly EnvSecretBinding[] = Object.freeze([
  { blockName: 'posthog', secretKey: 'apiKey', environmentVariable: 'GLIMMERVOID_POSTHOG_API_KEY', isEnvironmentOnly: false },
  { blockName: 'posthog', secretKey: 'readApiKey', environmentVariable: 'GLIMMERVOID_POSTHOG_READ_API_KEY', isEnvironmentOnly: false },
  { blockName: 'telegram', secretKey: 'botToken', environmentVariable: 'GLIMMERVOID_TELEGRAM_BOT_TOKEN', isEnvironmentOnly: false },
  { blockName: 'github', secretKey: 'readToken', environmentVariable: 'GLIMMERVOID_GITHUB_READ_TOKEN', isEnvironmentOnly: false },
  { blockName: 'vault', secretKey: 'token', environmentVariable: 'GLIMMERVOID_VAULT_TOKEN', isEnvironmentOnly: true },
]);

const ENVIRONMENT_ONLY_BINDINGS = ENV_SECRET_BINDINGS.filter((binding) => binding.isEnvironmentOnly);
const STORED_SECRET_BINDINGS = ENV_SECRET_BINDINGS.filter((binding) => !binding.isEnvironmentOnly);

type StoredSecrets = Readonly<Record<string, string>>;

function storedSecretKey(binding: EnvSecretBinding): string {
  return `${binding.blockName}.${binding.secretKey}`;
}

function secretsHeldIn(config: ConfigBlocks): StoredSecrets {
  const heldByKey: Record<string, string> = {};
  for (const binding of STORED_SECRET_BINDINGS) {
    const block = config[binding.blockName];
    if (!isRecord(block)) continue;
    const value = block[binding.secretKey];
    if (typeof value !== 'string' || value.length === 0) continue;
    heldByKey[storedSecretKey(binding)] = value;
  }
  return heldByKey;
}

function heldSecrets(storedSecrets: StoredSecrets, envSecrets: readonly ResolvedEnvSecret[]): ResolvedEnvSecret[] {
  const envProvidedKeys = new Set(envSecrets.map(storedSecretKey));
  const fromStore = STORED_SECRET_BINDINGS.flatMap((binding) => {
    const key = storedSecretKey(binding);
    const value = storedSecrets[key];
    if (typeof value !== 'string' || value.length === 0 || envProvidedKeys.has(key)) return [];
    return [{ ...binding, value }];
  });
  return [...fromStore, ...envSecrets];
}

function nextStoredSecrets(storedSecrets: StoredSecrets, effectiveConfig: ConfigBlocks, envSecrets: readonly ResolvedEnvSecret[]): StoredSecrets {
  const envProvidedKeys = new Set(envSecrets.map(storedSecretKey));
  const heldInConfig = secretsHeldIn(effectiveConfig);
  const nextByKey: Record<string, string> = {};
  for (const binding of STORED_SECRET_BINDINGS) {
    const key = storedSecretKey(binding);
    const value = envProvidedKeys.has(key) ? storedSecrets[key] : heldInConfig[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    nextByKey[key] = value;
  }
  return nextByKey;
}

function readEnvSecrets(env: Record<string, string | undefined>): ResolvedEnvSecret[] {
  const resolvedSecrets: ResolvedEnvSecret[] = [];
  for (const binding of ENV_SECRET_BINDINGS) {
    const value = env[binding.environmentVariable];
    if (typeof value !== 'string' || value.length === 0) continue;
    resolvedSecrets.push({ ...binding, value });
  }
  return resolvedSecrets;
}

function copyOfBlock(config: ConfigBlocks, blockName: string): Record<string, unknown> {
  const block = config[blockName];
  if (!isRecord(block)) return {};
  return { ...block };
}

function withEnvSecrets<T extends ConfigBlocks>(config: T, envSecrets: readonly ResolvedEnvSecret[]): T {
  const withoutFileHeldEnvironmentOnlySecrets = withoutEnvSecrets(config, ENVIRONMENT_ONLY_BINDINGS);
  if (envSecrets.length === 0) return withoutFileHeldEnvironmentOnlySecrets;
  const overlaid: ConfigBlocks = { ...withoutFileHeldEnvironmentOnlySecrets };
  for (const secret of envSecrets) {
    overlaid[secret.blockName] = { ...copyOfBlock(overlaid, secret.blockName), [secret.secretKey]: secret.value };
  }
  return overlaid as T;
}

function withoutEnvSecrets<T extends ConfigBlocks>(config: T, envSecrets: readonly EnvSecretBinding[]): T {
  if (envSecrets.length === 0) return config;
  const stripped: ConfigBlocks = { ...config };
  for (const secret of envSecrets) {
    if (!isRecord(stripped[secret.blockName])) continue;
    const remaining = copyOfBlock(stripped, secret.blockName);
    delete remaining[secret.secretKey];
    if (Object.keys(remaining).length === 0) {
      delete stripped[secret.blockName];
      continue;
    }
    stripped[secret.blockName] = remaining;
  }
  return stripped as T;
}

function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withSortedKeys);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = withSortedKeys(value[key]);
  return sorted;
}

function stableConfigKey(value: unknown): string {
  return JSON.stringify(withSortedKeys(value));
}

export { ENV_SECRET_BINDINGS, heldSecrets, nextStoredSecrets, readEnvSecrets, secretsHeldIn, stableConfigKey, withEnvSecrets, withoutEnvSecrets };
export type { StoredSecrets };
