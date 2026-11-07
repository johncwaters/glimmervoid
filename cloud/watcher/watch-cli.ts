import crypto from 'node:crypto';
import { sendJob } from './job-inbox-client.ts';
import { createPingJob, parseInboxUrl } from './core/watcher-core.ts';
import { createWatcheeRunner } from './watchee-runner.ts';
import { watcherHomeDir } from './watchee-settings.ts';
import { WATCHEE_SETTINGS_CHANGED_MESSAGE } from '../../shared/contracts/watchee-settings.ts';
import { isRecord } from '../../shared/coerce.ts';

const WATCHER_TOKEN_ENV = 'GLIMMERVOID_WATCHER_TOKEN';
const PING_DELIVERY_ATTEMPTS = 3;
const IDLE_KEEP_ALIVE_MS = 2 ** 30;

const PARENT_LEFT = Symbol('parent left');

function whenSupervisorLeaves(): Promise<typeof PARENT_LEFT> | null {
  if (process.send === undefined) return null;
  if (!process.connected) return Promise.resolve(PARENT_LEFT);
  return new Promise((resolve) => { process.once('disconnect', () => resolve(PARENT_LEFT)); });
}

function untilStopSignal(supervisorLeft: Promise<typeof PARENT_LEFT> | null): Promise<void> {
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => {}, IDLE_KEEP_ALIVE_MS);
    const stop = () => {
      clearInterval(keepAlive);
      resolve();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    void supervisorLeft?.then(stop);
  });
}

async function runWatchCli({ inboxUrl, isPingOnly }: { inboxUrl: string | null; isPingOnly: boolean }): Promise<number> {
  const token = process.env[WATCHER_TOKEN_ENV] ?? '';
  if (token === '') {
    console.error(`watch: no ${WATCHER_TOKEN_ENV} set`);
    return 1;
  }
  const inbox = parseInboxUrl(inboxUrl);
  if (!inbox.ok) {
    console.error(`watch: ${inbox.reason}`);
    return 1;
  }
  const supervisorLeft = whenSupervisorLeaves();
  const startedAtMs = Date.now();
  const pingDelivery = sendJob({ jobsUrl: inbox.jobsUrl, token, job: createPingJob(crypto.randomUUID(), new Date()), maxAttempts: PING_DELIVERY_ATTEMPTS });
  const delivery = await Promise.race(supervisorLeft === null ? [pingDelivery] : [pingDelivery, supervisorLeft]);
  if (delivery === PARENT_LEFT) return 0;
  if (!delivery.ok) {
    console.error(`watch: ${delivery.reason}`);
    if (isPingOnly) return 1;
  }
  if (delivery.ok) console.log(`ping acked by ${inbox.jobsUrl} in ${Date.now() - startedAtMs} ms`);
  if (isPingOnly) return 0;
  const watcheeRunner = createWatcheeRunner({ watcherHome: watcherHomeDir(), jobsUrl: inbox.jobsUrl, settingsUrl: inbox.settingsUrl, token });
  process.on('message', (message: unknown) => {
    if (isRecord(message) && message.type === WATCHEE_SETTINGS_CHANGED_MESSAGE) void watcheeRunner.refreshSettings();
  });
  await watcheeRunner.start();
  await untilStopSignal(supervisorLeft);
  await watcheeRunner.stop();
  return 0;
}

export { runWatchCli };
