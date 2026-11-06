import crypto from 'node:crypto';
import { sendJob } from './job-inbox-client.ts';
import { createPingJob, parseInboxUrl } from './core/watcher-core.ts';

const WATCHER_TOKEN_ENV = 'GLIMMERVOID_WATCHER_TOKEN';
const PING_DELIVERY_ATTEMPTS = 3;
const IDLE_KEEP_ALIVE_MS = 2 ** 30;

function untilStopSignal(): Promise<void> {
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => {}, IDLE_KEEP_ALIVE_MS);
    const stop = () => {
      clearInterval(keepAlive);
      resolve();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
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
  const startedAtMs = Date.now();
  const delivery = await sendJob({ jobsUrl: inbox.jobsUrl, token, job: createPingJob(crypto.randomUUID(), new Date()), maxAttempts: PING_DELIVERY_ATTEMPTS });
  if (!delivery.ok) {
    console.error(`watch: ${delivery.reason}`);
    if (isPingOnly) return 1;
  }
  if (delivery.ok) console.log(`ping acked by ${inbox.jobsUrl} in ${Date.now() - startedAtMs} ms`);
  if (isPingOnly) return 0;
  await untilStopSignal();
  return 0;
}

export { runWatchCli };
