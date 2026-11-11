import { AwakeUsageNotified } from '../shared/contracts/watcher-link.ts';
import type { AwakeUsage } from '../shared/contracts/watcher-link.ts';
import { createJsonStateStore } from './json-file.ts';
import { awakeUsageAlertText, newlyCrossedAlert, notifiedAfter } from './core/awake-usage-core.ts';

const AWAKE_USAGE_NOTIFY_NAME = 'Awake hours';
const AWAKE_USAGE_NOTIFY_CATEGORY = 'awake-hours';
const DEFAULT_READ_EVERY_MS = 15 * 60_000;

function startAwakeUsageAlerts({ readAwakeUsage, notify, statePath, readEveryMs = DEFAULT_READ_EVERY_MS, log = console }: {
  readAwakeUsage: () => Promise<AwakeUsage | null>;
  notify: (name: string, category: string, message: string) => void;
  statePath: string | null;
  readEveryMs?: number;
  log?: Pick<Console, 'warn'>;
}): { stop(): void; check(): void; checked(): Promise<void> } {
  let notified: AwakeUsageNotified | null = null;
  let lastCheck: Promise<void> = Promise.resolve();
  const store = createJsonStateStore({
    name: 'awake usage alerts', filePath: statePath,
    parse: (raw) => AwakeUsageNotified.safeParse(raw).data ?? null,
    adopt: (loaded) => { notified = loaded; },
    warn: (message, fields) => log.warn(`[awake-usage] ${message} ${JSON.stringify(fields)}`),
  });
  const loaded = store.load();

  async function checkOnce(): Promise<void> {
    await loaded;
    const usage = await readAwakeUsage();
    if (usage === null) return;
    const alert = newlyCrossedAlert(usage, notified, 2 * readEveryMs);
    if (alert === null) return;
    notify(AWAKE_USAGE_NOTIFY_NAME, AWAKE_USAGE_NOTIFY_CATEGORY, awakeUsageAlertText(alert));
    const nextNotified = notifiedAfter(usage, alert);
    notified = nextNotified;
    await store.write(nextNotified, () => `${JSON.stringify(nextNotified, null, 2)}\n`);
  }

  function check(): void {
    lastCheck = lastCheck.then(checkOnce).catch((checkError: unknown) => log.warn(`[awake-usage] check failed: ${(checkError as Error).message}`));
  }

  check();
  const interval = setInterval(check, readEveryMs);
  interval.unref();
  return { stop: () => clearInterval(interval), check, checked: () => lastCheck };
}

export { startAwakeUsageAlerts };
