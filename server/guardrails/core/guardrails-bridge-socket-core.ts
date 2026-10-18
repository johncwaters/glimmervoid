import path from 'node:path';

const LONGEST_BRIDGE_SOCKET_NAME = 'claude-socks-0123456789abcdef.sock';
const UNIX_SOCKET_PATH_BYTE_LIMIT = 107;
const SHORT_BRIDGE_SOCKET_FOLDER = '/tmp';

function bridgeSocketPathBytes(tempDirectory: string): number {
  return Buffer.byteLength(path.join(tempDirectory, LONGEST_BRIDGE_SOCKET_NAME));
}

function hasRoomForBridgeSocket(tempDirectory: string, platform: NodeJS.Platform): boolean {
  return platform !== 'linux' || bridgeSocketPathBytes(tempDirectory) <= UNIX_SOCKET_PATH_BYTE_LIMIT;
}

function bridgeSocketLauncherEnv(inheritedTempDirectory: string, platform: NodeJS.Platform): Record<string, string> {
  if (hasRoomForBridgeSocket(inheritedTempDirectory, platform)) return { TMPDIR: inheritedTempDirectory };
  return { TMPDIR: SHORT_BRIDGE_SOCKET_FOLDER };
}

export { bridgeSocketLauncherEnv };
