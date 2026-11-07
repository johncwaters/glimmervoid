import { z } from 'zod';

export const WatcheeSettingsFile = z.object({
  version: z.literal(1),
}).strict();

export type WatcheeSettingsFile = z.infer<typeof WatcheeSettingsFile>;

export const WatcheeSettingsReply = z.strictObject({
  revision: z.string().min(1),
  settings: WatcheeSettingsFile,
});

export type WatcheeSettingsReply = z.infer<typeof WatcheeSettingsReply>;

export const WATCHEE_SETTINGS_PATH = '/watchees';
export const WATCHEE_SETTINGS_CHANGED_MESSAGE = 'watchee-settings-changed';

export const WATCHEE_SETTINGS_FILENAME = 'watchees.json';
export const SENT_EVENTS_FILENAME = 'sent-events.json';
export const WATCHER_HOME_ENV = 'GLIMMERVOID_WATCHER_HOME';
