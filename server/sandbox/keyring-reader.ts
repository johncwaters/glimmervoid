import net from 'node:net';
import os from 'node:os';
import { errorMessage } from '../../shared/text.ts';
import { decodeMessage, encodeMethodCall, externalAuthLine, getSecretCall, helloCall, isMessageTooLong, messageLengthOf, openSessionCall, replyFailureOf, searchItemsCall, searchResultOf, secretTextOf, sessionBusSocketPath, sessionPathOf } from './core/keyring-login-core.ts';
import type { DbusCall, DbusMessage, KeyringEntry } from './core/keyring-login-core.ts';

const KEYRING_READ_TIMEOUT_MS = 10_000;
const AUTH_ACCEPTED_PREFIX = 'OK ';
const AUTH_LINE_END = '\r\n';

type KeyringRead = { secret: string } | { refusal: string };

interface BusConnection {
  call: (makeCall: (serial: number) => DbusCall) => Promise<DbusMessage>;
}

function connectToBus(socket: net.Socket, userId: number): Promise<BusConnection> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    let isAuthenticated = false;
    let nextSerial = 1;
    const pendingBySerial = new Map<number, { resolve: (message: DbusMessage) => void; reject: (error: Error) => void }>();
    const failAll = (error: Error) => {
      reject(error);
      for (const pending of pendingBySerial.values()) pending.reject(error);
      pendingBySerial.clear();
    };
    const readMessages = () => {
      if (isMessageTooLong(received)) return failAll(new Error('the session bus sent an oversized message'));
      const length = messageLengthOf(received);
      if (length === null || received.length < length) return;
      const message = decodeMessage(received.subarray(0, length));
      received = received.subarray(length);
      const pending = message?.replySerial === null || message === null ? undefined : pendingBySerial.get(message.replySerial);
      if (message !== null && message.replySerial !== null && pending !== undefined) {
        pendingBySerial.delete(message.replySerial);
        pending.resolve(message);
      }
      readMessages();
    };
    const readAuthReply = () => {
      const lineEnd = received.indexOf(AUTH_LINE_END);
      if (lineEnd < 0) return;
      const line = received.subarray(0, lineEnd).toString('utf8');
      received = received.subarray(lineEnd + AUTH_LINE_END.length);
      if (!line.startsWith(AUTH_ACCEPTED_PREFIX)) return failAll(new Error(`the session bus refused authentication: ${line}`));
      isAuthenticated = true;
      socket.write('BEGIN\r\n');
      resolve({
        call: (makeCall) => new Promise((resolveCall, rejectCall) => {
          const serial = nextSerial;
          nextSerial += 1;
          pendingBySerial.set(serial, { resolve: resolveCall, reject: rejectCall });
          socket.write(encodeMethodCall(makeCall(serial)));
        }),
      });
    };
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (isAuthenticated) return readMessages();
      readAuthReply();
    });
    socket.on('error', failAll);
    socket.on('close', () => failAll(new Error('the session bus closed the connection')));
    socket.on('connect', () => socket.write(Buffer.concat([Buffer.alloc(1), Buffer.from(externalAuthLine(userId), 'utf8')])));
  });
}

async function readThroughConnection(connection: BusConnection, entry: KeyringEntry): Promise<KeyringRead> {
  const hello = await connection.call(helloCall);
  const helloFailure = replyFailureOf(hello);
  if (helloFailure !== null) return { refusal: `the session bus refused Hello: ${helloFailure}` };
  const session = await connection.call(openSessionCall);
  const sessionFailure = replyFailureOf(session);
  const sessionPath = sessionPathOf(session);
  if (sessionFailure !== null || sessionPath === null) return { refusal: `no Secret Service answers on the session bus (${sessionFailure ?? 'no session path'})` };
  const search = await connection.call((serial) => searchItemsCall(serial, entry));
  const searchFailure = replyFailureOf(search);
  if (searchFailure !== null) return { refusal: `the Secret Service search failed: ${searchFailure}` };
  const items = searchResultOf(search);
  const itemPath = items.unlocked[0];
  if (itemPath === undefined && items.locked.length > 0) return { refusal: `the login keyring holding ${entry.service}/${entry.account} is locked; unlock it` };
  if (itemPath === undefined) return { refusal: `the login keyring holds no ${entry.service}/${entry.account} entry` };
  const secret = await connection.call((serial) => getSecretCall(serial, itemPath, sessionPath));
  const secretFailure = replyFailureOf(secret);
  const secretText = secretTextOf(secret);
  if (secretFailure !== null || secretText === null) return { refusal: `the Secret Service did not hand over ${entry.service}/${entry.account} (${secretFailure ?? 'unreadable reply'})` };
  return { secret: secretText };
}

async function readSecretService(entry: KeyringEntry): Promise<KeyringRead> {
  const userId = os.userInfo().uid;
  const socket = net.createConnection({ path: sessionBusSocketPath(process.env.DBUS_SESSION_BUS_ADDRESS, userId) });
  const timer = setTimeout(() => socket.destroy(new Error(`the keyring did not answer within ${KEYRING_READ_TIMEOUT_MS / 1000} s`)), KEYRING_READ_TIMEOUT_MS);
  try {
    const connection = await connectToBus(socket, userId);
    return await readThroughConnection(connection, entry);
  } catch (error) {
    return { refusal: `the keyring could not be read: ${errorMessage(error)}` };
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

async function readKeyringSecret(entry: KeyringEntry, platform: NodeJS.Platform = process.platform): Promise<KeyringRead> {
  if (platform !== 'linux') return { refusal: `Glimmervoid reads the ${entry.service}/${entry.account} keyring login only on Linux` };
  return readSecretService(entry);
}

export { readKeyringSecret };
export type { KeyringRead };
