import path from 'node:path';

const VAULT_COMPANION_FILENAME = 'vault-companion.json';
const WATCHER_LINK_KEY_FILENAME = 'watcher-link.key';
const SECRETS_DIRNAME = 'secrets';
const CONFIG_SECRETS_FILENAME = 'config-secrets.json';

function configBackupPath(configPath: string): string {
  return `${configPath}.bak`;
}

function retiredConfigBackupPaths(configPath: string): string[] {
  return [`${configPath}.boot.bak`, `${configPath}.invalid.bak`];
}

function configSecretsFilename(configPath: string): string {
  const configFilename = path.basename(configPath);
  if (configFilename === 'config.json') return CONFIG_SECRETS_FILENAME;
  return `${configFilename}.secrets.json`;
}

function configSecretsPath(configPath: string): string {
  return path.join(path.dirname(configPath), SECRETS_DIRNAME, configSecretsFilename(configPath));
}

function vaultCompanionPath(glimmervoidHome: string): string {
  return path.join(glimmervoidHome, SECRETS_DIRNAME, VAULT_COMPANION_FILENAME);
}

function legacyVaultCompanionPath(glimmervoidHome: string): string {
  return path.join(glimmervoidHome, VAULT_COMPANION_FILENAME);
}

function watcherLinkKeyPath(glimmervoidHome: string): string {
  return path.join(glimmervoidHome, SECRETS_DIRNAME, WATCHER_LINK_KEY_FILENAME);
}

function legacyWatcherLinkKeyPath(glimmervoidHome: string): string {
  return path.join(glimmervoidHome, WATCHER_LINK_KEY_FILENAME);
}

function movedSecretPath(legacySecretPath: string): string {
  return path.join(path.dirname(legacySecretPath), SECRETS_DIRNAME, path.basename(legacySecretPath));
}

function glimmervoidSecretPaths({ glimmervoidHome, configPath }: { glimmervoidHome: string; configPath: string }): string[] {
  return [...new Set([
    configPath,
    configBackupPath(configPath),
    path.dirname(configSecretsPath(configPath)),
    path.join(glimmervoidHome, SECRETS_DIRNAME),
    legacyVaultCompanionPath(glimmervoidHome),
    legacyWatcherLinkKeyPath(glimmervoidHome),
  ])];
}

export { configBackupPath, configSecretsPath, glimmervoidSecretPaths, legacyVaultCompanionPath, legacyWatcherLinkKeyPath, movedSecretPath, retiredConfigBackupPaths, vaultCompanionPath, watcherLinkKeyPath };
