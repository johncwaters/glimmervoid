import type { WatcheeSettingsFile } from '../../shared/contracts/watchee-settings.ts';

function watcheeSettingsFromConfig(): WatcheeSettingsFile {
  return { version: 1 };
}

export { watcheeSettingsFromConfig };
