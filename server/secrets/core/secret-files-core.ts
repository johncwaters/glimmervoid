import path from 'node:path';

const VAULT_COMPANION_FILENAME = 'vault-companion.json';
const WATCHER_LINK_KEY_FILENAME = 'watcher-link.key';

function configBackupPath(configPath: string): string {
  return `${configPath}.bak`;
}

function retiredConfigBackupPaths(configPath: string): string[] {
  return [`${configPath}.boot.bak`, `${configPath}.invalid.bak`];
}

function glimmervoidSecretPaths({ glimmervoidHome, configPath }: { glimmervoidHome: string; configPath: string }): string[] {
  return [
    configPath,
    configBackupPath(configPath),
    path.join(glimmervoidHome, VAULT_COMPANION_FILENAME),
    path.join(glimmervoidHome, WATCHER_LINK_KEY_FILENAME),
  ];
}

export { VAULT_COMPANION_FILENAME, WATCHER_LINK_KEY_FILENAME, configBackupPath, glimmervoidSecretPaths, retiredConfigBackupPaths };
