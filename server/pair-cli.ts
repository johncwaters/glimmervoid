import fs from 'node:fs';

import { glimmervoidHomeDir, resolveConfigPath } from './config-store.ts';
import { normalizeRemoteConfig, remoteListenerPortPath, resolveLocalPort } from './core/remote-config.ts';
import { DEFAULT_CONFIG } from './config/config-defaults.ts';
import {
  REVOCATION_PROPAGATION_SECONDS,
  createPairingsStore, createSeenStore, defaultPairingsPath, defaultSeenPath,
} from './pairings-store.ts';
import type { PairingsStore, SeenStore } from './pairings-store.ts';
import { formatTimestamp } from './text-format.ts';
import { errorMessage } from '../shared/text.ts';

const PASSWORD_WARNING = [
  'Treat this link like a password. Anyone who opens it gets full control of this',
  'machine through Glimmervoid (it can start Claude Code sessions in any directory).',
  'It works once and expires in 10 minutes.',
].join('\n');

interface RemoteSettings {
  port: number | null;
  publicHost: string;
}

function readConfig(configPath: string): { remote?: unknown; port?: unknown } | null {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error(`Could not read ${configPath}: ${errorMessage(err)}`);
    return null;
  }
}

function readBoundRemotePort(localPort: number): number | null {
  try {
    const boundPort = Number.parseInt(fs.readFileSync(remoteListenerPortPath(glimmervoidHomeDir(), localPort), 'utf8').trim(), 10);
    return Number.isInteger(boundPort) ? boundPort : null;
  } catch {
    return null;
  }
}

function buildPairUrl(remote: RemoteSettings, token: string): string {
  if (remote.publicHost) return `https://${remote.publicHost}/pair/${token}`;
  return `http://127.0.0.1:${remote.port}/pair/${token}`;
}

function runMint(store: PairingsStore, remote: RemoteSettings, name: string | null): number {
  if (!remote.publicHost && remote.port === null) {
    console.error('The remote listener port is not known yet, so a pairing link cannot be built.');
    console.error('Start Glimmervoid first, or set remote.port (and remote.publicHost for a shareable link) in config.json.');
    return 1;
  }
  const minted = store.mintPending({ name: name || '' });
  if (!minted) {
    console.error('Failed to write the pairing file - no token was created.');
    return 1;
  }
  console.log('');
  console.log(`  ${buildPairUrl(remote, minted.token)}`);
  console.log('');
  console.log(PASSWORD_WARNING);
  if (!remote.publicHost) {
    console.log('');
    console.log('remote.publicHost is not set, so the link above points at loopback.');
    console.log('Set it to the hostname your reverse proxy serves to get a shareable link.');
  }
  return 0;
}

function runList(store: PairingsStore, seenStore: SeenStore): number {
  const devices = store.listDevices();
  if (devices.length === 0) {
    console.log('No paired devices.');
    return 0;
  }
  const seen = seenStore.readAll();
  console.log(`${'ID'.padEnd(14)}${'NAME'.padEnd(22)}${'PAIRED'.padEnd(21)}${'LAST SEEN'.padEnd(21)}STATUS`);
  for (const device of devices) {
    const status = device.revokedAt ? `revoked ${formatTimestamp(device.revokedAt)}` : 'active';
    console.log(
      device.id.padEnd(14)
      + (device.name || '-').padEnd(22)
      + formatTimestamp(device.createdAt).padEnd(21)
      + formatTimestamp(seen[device.id]).padEnd(21)
      + status,
    );
  }
  return 0;
}

function runRevoke(store: PairingsStore, id: string): number {
  const outcome = store.revokeDevice(id);
  if (outcome.ok) {
    console.log(`Revoked ${id}. A running Glimmervoid applies this within ${REVOCATION_PROPAGATION_SECONDS} seconds, no restart needed.`);
    return 0;
  }
  if (outcome.reason === 'unknown') {
    console.error(`No paired device with id ${id}. Run "glimmervoid pair --list" to see the ids.`);
    return 1;
  }
  console.error('Failed to write the pairing file - nothing was revoked.');
  return 1;
}

interface PairRequest {
  isListing: boolean;
  revokeDeviceId: string | null;
  deviceName: string | null;
}

function runPairCli({ isListing, revokeDeviceId, deviceName }: PairRequest): number {
  const configPath = resolveConfigPath();
  const config = readConfig(configPath);
  if (!config) return 1;
  const configuredRemote = normalizeRemoteConfig(config.remote);
  const localPort = resolveLocalPort({ envPort: process.env.GLIMMERVOID_PORT, configPort: config.port, defaultPort: DEFAULT_CONFIG.port });
  const remote = { ...configuredRemote, port: configuredRemote.port ?? readBoundRemotePort(localPort) };
  const store = createPairingsStore({ filePath: defaultPairingsPath(configPath) });
  const seenStore = createSeenStore({ filePath: defaultSeenPath(configPath) });

  if (isListing) return runList(store, seenStore);
  if (revokeDeviceId !== null) return runRevoke(store, revokeDeviceId);

  store.prunePending();
  return runMint(store, remote, deviceName);
}

export { runPairCli };
