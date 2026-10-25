import net from 'node:net';
import zlib from 'node:zlib';
import { CHANNELS, classifyChannel, openCongestionWindow, schedulePieces } from './shaping-core.ts';
import type { Channel, CongestionWindow, LinkProfile, SharedLink } from './shaping-core.ts';

export interface ChannelTally {
  connections: number;
  wireBytesDown: number;
  wireBytesUp: number;
  gzipBytesDown: number;
  serverWaitMs: number;
  serverTurns: number;
}

export type ChannelTallies = Record<Channel, ChannelTally>;

interface ChannelMeasure {
  tally: ChannelTally;
  gzip: zlib.Gzip;
  gzipEnded: Promise<void>;
}

type Measure = Record<Channel, ChannelMeasure>;

interface QueuedChunk {
  deliverAtMs: number;
  bytes: Buffer;
}

interface DeliveryQueue {
  push(bytes: Buffer, nowMs: number): void;
  whenDrained(callback: () => void): void;
  stop(): void;
}

export interface ShapingProxy {
  port: number;
  beginMeasure(): void;
  endMeasure(): Promise<ChannelTallies>;
  close(): Promise<void>;
}

const SOCKS_VERSION = 5;
const SOCKS_CONNECT = 1;
const ADDRESS_IPV4 = 1;
const ADDRESS_DOMAIN = 3;
const ADDRESS_IPV6 = 4;
const SOCKS_SUCCEEDED = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
const SOCKS_REFUSED = Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]);
const LOOPBACK_TARGETS = new Set(['127.0.0.1', 'localhost']);

function emptyTally(): ChannelTally {
  return { connections: 0, wireBytesDown: 0, wireBytesUp: 0, gzipBytesDown: 0, serverWaitMs: 0, serverTurns: 0 };
}

function openChannelMeasure(): ChannelMeasure {
  const tally = emptyTally();
  const gzip = zlib.createGzip();
  gzip.on('data', (compressed: Buffer) => { tally.gzipBytesDown += compressed.length; });
  const gzipEnded = new Promise<void>((resolve) => { gzip.once('end', resolve); });
  return { tally, gzip, gzipEnded };
}

function openMeasure(): Measure {
  return { http: openChannelMeasure(), control: openChannelMeasure(), data: openChannelMeasure() };
}

function createDeliveryQueue(profile: LinkProfile, link: SharedLink, window: CongestionWindow, write: (bytes: Buffer) => void): DeliveryQueue {
  const queued: QueuedChunk[] = [];
  let pumpTimer: NodeJS.Timeout | null = null;
  let drainedCallbacks: Array<() => void> = [];
  const pump = (): void => {
    pumpTimer = null;
    const nowMs = performance.now();
    while (queued.length > 0 && (queued[0]?.deliverAtMs ?? 0) <= nowMs) {
      const chunk = queued.shift();
      if (chunk) write(chunk.bytes);
    }
    if (queued.length > 0) {
      pumpTimer = setTimeout(pump, Math.max(0, (queued[0]?.deliverAtMs ?? nowMs) - nowMs));
      return;
    }
    const callbacks = drainedCallbacks;
    drainedCallbacks = [];
    for (const callback of callbacks) callback();
  };
  return {
    push(bytes, nowMs) {
      let offset = 0;
      for (const piece of schedulePieces(bytes.length, nowMs, link, window, profile)) {
        queued.push({ deliverAtMs: piece.deliverAtMs, bytes: bytes.subarray(offset, offset + piece.byteCount) });
        offset += piece.byteCount;
      }
      if (pumpTimer === null) pump();
    },
    whenDrained(callback) {
      if (queued.length === 0) {
        callback();
        return;
      }
      drainedCallbacks.push(callback);
    },
    stop() {
      if (pumpTimer !== null) clearTimeout(pumpTimer);
      queued.length = 0;
      drainedCallbacks = [];
    },
  };
}

function readSocksTarget(buffered: Buffer): { host: string; port: number; consumedBytes: number } | null {
  if (buffered.length < 5) return null;
  const addressType = buffered[3];
  if (addressType === ADDRESS_IPV4) {
    if (buffered.length < 10) return null;
    return { host: [...buffered.subarray(4, 8)].join('.'), port: buffered.readUInt16BE(8), consumedBytes: 10 };
  }
  if (addressType === ADDRESS_DOMAIN) {
    const nameLength = buffered[4] ?? 0;
    if (buffered.length < 7 + nameLength) return null;
    return { host: buffered.subarray(5, 5 + nameLength).toString('latin1'), port: buffered.readUInt16BE(5 + nameLength), consumedBytes: 7 + nameLength };
  }
  if (addressType === ADDRESS_IPV6) {
    if (buffered.length < 22) return null;
    return { host: 'ipv6', port: buffered.readUInt16BE(20), consumedBytes: 22 };
  }
  return { host: 'unsupported', port: 0, consumedBytes: buffered.length };
}

export async function createShapingProxy({ targetPort, profile }: { targetPort: number; profile: LinkProfile }): Promise<ShapingProxy> {
  const downLink: SharedLink = { freeAtMs: 0 };
  const upLink: SharedLink = { freeAtMs: 0 };
  const openSockets = new Set<net.Socket>();
  let measure = openMeasure();

  const tunnel = (client: net.Socket, server: net.Socket, establishedAtMs: number, leftover: Buffer): void => {
    let channel: Channel | null = null;
    let isAwaitingResponse = false;
    let lastUpstreamWriteMs = 0;
    let isCountingTurns = true;
    const toServer = createDeliveryQueue(profile, upLink, openCongestionWindow(profile, establishedAtMs), (bytes) => {
      server.write(bytes);
      lastUpstreamWriteMs = performance.now();
      isAwaitingResponse = true;
    });
    const toClient = createDeliveryQueue(profile, downLink, openCongestionWindow(profile, establishedAtMs), (bytes) => { client.write(bytes); });
    const fromClient = (bytes: Buffer): void => {
      if (channel === null) {
        channel = classifyChannel(bytes.toString('latin1'));
        measure[channel].tally.connections += 1;
      }
      measure[channel].tally.wireBytesUp += bytes.length;
      toServer.push(bytes, performance.now());
    };
    server.on('data', (bytes: Buffer) => {
      const current = measure[channel ?? 'http'];
      current.tally.wireBytesDown += bytes.length;
      current.gzip.write(bytes);
      if (isAwaitingResponse && isCountingTurns) {
        current.tally.serverWaitMs += performance.now() - lastUpstreamWriteMs;
        current.tally.serverTurns += 1;
        if (channel !== 'http') isCountingTurns = false;
      }
      isAwaitingResponse = false;
      toClient.push(bytes, performance.now());
    });
    client.on('data', fromClient);
    server.on('end', () => { toClient.whenDrained(() => client.end()); });
    client.on('end', () => { toServer.whenDrained(() => server.end()); });
    const tearDown = (): void => {
      toServer.stop();
      toClient.stop();
      client.destroy();
      server.destroy();
    };
    server.on('error', tearDown);
    client.on('error', tearDown);
    server.on('close', () => { toClient.whenDrained(() => client.destroy()); });
    client.on('close', tearDown);
    if (leftover.length > 0) fromClient(leftover);
  };

  const accept = (client: net.Socket): void => {
    openSockets.add(client);
    client.on('close', () => openSockets.delete(client));
    client.on('error', () => client.destroy());
    let buffered = Buffer.alloc(0);
    let hasGreeted = false;
    const onHandshake = (bytes: Buffer): void => {
      buffered = Buffer.concat([buffered, bytes]);
      if (!hasGreeted) {
        if (buffered.length < 2 || buffered.length < 2 + (buffered[1] ?? 0)) return;
        if (buffered[0] !== SOCKS_VERSION) {
          client.destroy();
          return;
        }
        buffered = buffered.subarray(2 + (buffered[1] ?? 0));
        hasGreeted = true;
        client.write(Buffer.from([SOCKS_VERSION, 0]));
      }
      const target = readSocksTarget(buffered);
      if (!target) return;
      client.off('data', onHandshake);
      const leftover = buffered.subarray(target.consumedBytes);
      if (buffered[1] !== SOCKS_CONNECT || !LOOPBACK_TARGETS.has(target.host) || target.port !== targetPort) {
        client.end(SOCKS_REFUSED);
        return;
      }
      client.pause();
      const server = net.connect({ host: '127.0.0.1', port: targetPort });
      openSockets.add(server);
      server.on('close', () => openSockets.delete(server));
      server.once('error', () => client.destroy());
      server.once('connect', () => {
        setTimeout(() => {
          client.write(SOCKS_SUCCEEDED);
          tunnel(client, server, performance.now(), leftover);
          client.resume();
        }, 2 * profile.oneWayDelayMs);
      });
    };
    client.on('data', onHandshake);
  };

  const listener = net.createServer(accept);
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => resolve());
  });
  const address = listener.address();
  if (typeof address !== 'object' || address === null) throw new Error('shaping proxy did not bind a port');

  return {
    port: address.port,
    beginMeasure() {
      measure = openMeasure();
    },
    async endMeasure() {
      const finished = measure;
      measure = openMeasure();
      for (const channel of CHANNELS) finished[channel].gzip.end();
      await Promise.all(CHANNELS.map((channel) => finished[channel].gzipEnded));
      return { http: finished.http.tally, control: finished.control.tally, data: finished.data.tally };
    },
    async close() {
      for (const socket of openSockets) socket.destroy();
      await new Promise<void>((resolve) => { listener.close(() => resolve()); });
    },
  };
}
