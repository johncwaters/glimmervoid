const FORWARDED_UPGRADE_HEADERS = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol'];

interface HostRoute {
  tunnelPort: number;
  hostDashboardPort: number;
  hostToken: string;
}

function upstreamQuery(rawUrl: string, hostToken: string): string {
  const queryAt = rawUrl.indexOf('?');
  const queryText = queryAt === -1 ? '' : rawUrl.slice(queryAt + 1).split('#')[0];
  const params = new URLSearchParams(queryText);
  params.set('token', hostToken);
  return params.toString();
}

function upstreamUpgradeRequest(
  { rawUrl, headers }: { rawUrl: string; headers: Readonly<Record<string, string | string[] | undefined>> },
  upstreamPath: string,
  route: HostRoute,
): string {
  const lines = [
    `GET ${upstreamPath}?${upstreamQuery(rawUrl, route.hostToken)} HTTP/1.1`,
    `Host: 127.0.0.1:${route.tunnelPort}`,
    `Origin: http://127.0.0.1:${route.hostDashboardPort}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
  ];
  for (const name of FORWARDED_UPGRADE_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string') lines.push(`${name}: ${value}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

export { upstreamUpgradeRequest };
export type { HostRoute };
