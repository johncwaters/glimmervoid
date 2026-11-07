import net from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { upstreamUpgradeRequest } from './core/host-relay-core.ts';
import type { HostRoute } from './core/host-relay-core.ts';

const HOST_UNAVAILABLE_RESPONSE = 'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n';

function refuseHostUpgrade(socket: Duplex): void {
  socket.write(HOST_UNAVAILABLE_RESPONSE);
  socket.destroy();
}

function relayUpgradeToHost({ request, socket, head, upstreamPath, route }: {
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  upstreamPath: string;
  route: HostRoute | null;
}): void {
  if (!route) {
    refuseHostUpgrade(socket);
    return;
  }
  const upstream = net.connect({ host: '127.0.0.1', port: route.tunnelPort });
  upstream.setNoDelay(true);
  const closeBoth = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.once('error', closeBoth);
  upstream.once('close', closeBoth);
  socket.once('error', closeBoth);
  socket.once('close', closeBoth);
  upstream.write(upstreamUpgradeRequest({ rawUrl: request.url ?? '', headers: request.headers }, upstreamPath, route));
  if (head.length > 0) upstream.write(head);
  upstream.pipe(socket);
  socket.pipe(upstream);
}

export { refuseHostUpgrade, relayUpgradeToHost };
