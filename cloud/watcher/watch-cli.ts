import os from 'node:os';
import path from 'node:path';
import { credentialStoreKey, directionKey } from '../link/core/link-signing-core.ts';
import { isLinkUrlSafe, LINK_SECRET_ENV, LINK_SERVER_URL_ENV, WATCHER_HOME_ENV, WATCHER_LISTENING_MESSAGE } from '../../shared/contracts/watcher-link.ts';
import { createNudgeSender, createProbeRunner } from './probe-runner.ts';
import { createWatcherHome } from './watcher-home.ts';
import { createWatcherListener } from './watcher-listener.ts';

const MIN_LINK_SECRET_BYTES = 32;
const HEX_PATTERN = /^[0-9a-f]+$/i;

function linkSecretFromEnvironment(): Buffer | { refusal: string } {
  const secretHex = process.env[LINK_SECRET_ENV] ?? '';
  delete process.env[LINK_SECRET_ENV];
  if (!HEX_PATTERN.test(secretHex) || secretHex.length < MIN_LINK_SECRET_BYTES * 2) return { refusal: `${LINK_SECRET_ENV} must hold at least ${MIN_LINK_SECRET_BYTES} bytes as hex` };
  return Buffer.from(secretHex, 'hex');
}

function serverUrlFromEnvironment(): URL | { refusal: string } {
  const rawServerUrl = process.env[LINK_SERVER_URL_ENV] ?? '';
  if (!URL.canParse(rawServerUrl)) return { refusal: `${LINK_SERVER_URL_ENV} must be the server's URL` };
  if (!isLinkUrlSafe(rawServerUrl)) return { refusal: `${LINK_SERVER_URL_ENV} must use https for a host other than this machine` };
  return new URL(rawServerUrl);
}

function portFromOption(rawPort: string | null): number | null {
  if (rawPort === null) return 0;
  const port = Number(rawPort);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
}

function refuse(reason: string): number {
  console.error(`watch: ${reason}`);
  return 1;
}

function untilStopped(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGTERM', () => resolve());
    process.once('SIGINT', () => resolve());
    if (process.send !== undefined) process.once('disconnect', () => resolve());
  });
}

async function runWatchCli({ rawPort }: { rawPort: string | null }): Promise<number> {
  const linkSecret = linkSecretFromEnvironment();
  if ('refusal' in linkSecret) return refuse(linkSecret.refusal);
  const serverUrl = serverUrlFromEnvironment();
  if ('refusal' in serverUrl) return refuse(serverUrl.refusal);
  const port = portFromOption(rawPort);
  if (port === null) return refuse('--port must be a port from 0 to 65535');
  const homeDir = process.env[WATCHER_HOME_ENV] || path.join(os.homedir(), '.glimmervoid-watcher');
  const home = createWatcherHome({ homeDir, credentialKey: credentialStoreKey(linkSecret) });
  const nudges = createNudgeSender({ serverUrl: serverUrl.href, signingKey: directionKey(linkSecret, 'watcher-to-server') });
  const runner = createProbeRunner({ home, nudges });
  const listener = createWatcherListener({ runner, signingKey: directionKey(linkSecret, 'server-to-watcher') });
  await runner.start();
  const boundPort = await listener.listen(port);
  console.log(`[watcher] listening on 127.0.0.1:${boundPort}, nudging ${serverUrl.origin}`);
  process.send?.({ type: WATCHER_LISTENING_MESSAGE, port: boundPort });
  await untilStopped();
  runner.stop();
  nudges.stop();
  await listener.close();
  return 0;
}

export { runWatchCli };
