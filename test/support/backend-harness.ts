import type { Server } from 'node:http';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import WebSocket from 'ws';

import { dashboardClient } from '../../tests/helpers/dashboard-ws.ts';

const CLAUDE_CONFIG_DIRECTORY_NAME = 'claude-config';
const CREDENTIALS_COPY_NAME = '.credentials.json';

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown) => {
      server.off('listening', onListening);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function closeServer(server: Server | null | undefined): Promise<void> {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function findFreeHighPort(): Promise<number> {
  const reservationServer = http.createServer();
  await listen(reservationServer, 0);
  const address = reservationServer.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await closeServer(reservationServer);
  if (port === null || !Number.isInteger(port) || port < 1024) throw new Error('could not reserve a free high port');
  return port;
}

async function connectControl(port: number): Promise<WebSocket> {
  const client = await dashboardClient(port);
  const socket = new WebSocket(client.url('/control'), client.options);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

function safeTextTail(value: unknown, maxCharacters = 2048): string {
  return stripVTControlCharacters(String(value || ''))
    .replace(/https?:\/\/\S+/g, '<redacted-url>')
    .slice(-maxCharacters);
}

function credentialsCopyPath(tempDirectory: string): string {
  return path.join(tempDirectory, CLAUDE_CONFIG_DIRECTORY_NAME, CREDENTIALS_COPY_NAME);
}

function removeHarnessTempDirectory(tempDirectory: string): void {
  try {
    fs.rmSync(tempDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.error(`temp directory removal failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const leftoverCredentialsPath = credentialsCopyPath(tempDirectory);
  if (!fs.existsSync(leftoverCredentialsPath)) return;
  console.error(`WARNING: copied Claude credentials remain at ${leftoverCredentialsPath}, delete them by hand`);
  process.exitCode = 1;
}

export {
  closeServer,
  connectControl,
  findFreeHighPort,
  listen,
  removeHarnessTempDirectory,
  safeTextTail,
};
