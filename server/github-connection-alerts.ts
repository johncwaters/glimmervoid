import { GithubConnectionNotified } from '../shared/contracts/watcher-link.ts';
import type { GithubConnection, GithubConnectionAction } from '../shared/contracts/watcher-link.ts';
import { clock } from '../shared/clock.ts';
import { COMMIT_SIGNING_NOTIFY_CATEGORY } from './commit-signing.ts';
import { createJsonStateStore } from './json-file.ts';
import { githubConnectionAlertStep } from './core/github-connection-alerts-core.ts';

const GITHUB_CONNECTION_NOTIFY_NAME = 'GitHub';
const GITHUB_CONNECTION_NOTIFY_CATEGORY = 'github-connection';
const DEFAULT_READ_EVERY_MS = 60 * 60_000;

function startGithubConnectionAlerts({ githubConnection, noticeOfKeyGoneFromGithub, notify, statePath, readEveryMs = DEFAULT_READ_EVERY_MS, now = clock.nowMs, log = console }: {
  githubConnection: (action: GithubConnectionAction) => Promise<GithubConnection | null>;
  noticeOfKeyGoneFromGithub?: () => Promise<string | null>;
  notify: (name: string, category: string, message: string) => void;
  statePath: string | null;
  readEveryMs?: number;
  now?: () => number;
  log?: Pick<Console, 'warn'>;
}): { stop(): void; check(): void; checked(): Promise<void> } {
  let notified: GithubConnectionNotified | null = null;
  let lastCheck: Promise<void> = Promise.resolve();
  const store = createJsonStateStore({
    name: 'github connection alerts', filePath: statePath,
    parse: (raw) => GithubConnectionNotified.safeParse(raw).data ?? null,
    adopt: (loaded) => { notified = loaded; },
    warn: (message, fields) => log.warn(`[github-connection] ${message} ${JSON.stringify(fields)}`),
  });
  const loaded = store.load();

  async function checkOnce(): Promise<void> {
    await loaded;
    const connection = await githubConnection('read');
    if (connection === null) return;
    const signingKeyNotice = connection.state === 'connected' ? await noticeOfKeyGoneFromGithub?.() ?? null : null;
    if (signingKeyNotice !== null) notify(GITHUB_CONNECTION_NOTIFY_NAME, COMMIT_SIGNING_NOTIFY_CATEGORY, signingKeyNotice);
    const step = githubConnectionAlertStep(connection, notified, { nowMs: now(), operatorDayOf: (epochMs) => clock.dayKeyOf(epochMs) });
    if (step.message !== null) notify(GITHUB_CONNECTION_NOTIFY_NAME, GITHUB_CONNECTION_NOTIFY_CATEGORY, step.message);
    if (JSON.stringify(step.notified) === JSON.stringify(notified)) return;
    const nextNotified = step.notified;
    notified = nextNotified;
    await store.write(nextNotified, () => `${JSON.stringify(nextNotified, null, 2)}\n`);
  }

  function check(): void {
    lastCheck = lastCheck.then(checkOnce).catch((checkError: unknown) => log.warn(`[github-connection] check failed: ${(checkError as Error).message}`));
  }

  check();
  const interval = setInterval(check, readEveryMs);
  interval.unref();
  return { stop: () => clearInterval(interval), check, checked: () => lastCheck };
}

export { startGithubConnectionAlerts };
