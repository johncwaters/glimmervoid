import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

import { createBackendHttpApp } from '../server/backend-http.ts';
import type { BackendHttpDependencies } from '../server/backend-http.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';

const OGG_BYTES = Buffer.from('OggS fake audio payload');

function makeHomeWithSounds(): { home: string; soundsDir: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-custom-sounds-'));
  const soundsDir = path.join(home, 'sounds');
  fs.mkdirSync(soundsDir);
  fs.writeFileSync(path.join(soundsDir, 'alarm.ogg'), OGG_BYTES);
  fs.writeFileSync(path.join(soundsDir, 'my chime.mp3'), OGG_BYTES);
  fs.writeFileSync(path.join(soundsDir, 'notes.txt'), 'not audio');
  fs.writeFileSync(path.join(soundsDir, '.hidden.ogg'), OGG_BYTES);
  fs.writeFileSync(path.join(home, 'secret.ogg'), 'outside the sounds dir');
  fs.symlinkSync(path.join(home, 'secret.ogg'), path.join(soundsDir, 'escape.ogg'));
  return { home, soundsDir };
}

function appDependencies(overrides: Partial<BackendHttpDependencies>): BackendHttpDependencies {
  return {
    staticDir: null,
    configStore: { configPath: path.join(os.tmpdir(), 'glimmervoid-custom-sounds-config.json') },
    remote: { allowedOrigins: [] },
    remoteAuth: null,
    allowedHosts: [],
    listenerPortsFor: (socket) => (typeof socket?.localPort === 'number' ? [socket.localPort] : []),
    pageToken: 'custom-sounds-page-token',
    hookRouter: { handle: () => ({ status: 200, reason: 'ok' }) },
    getSession: () => null,
    getUsage: () => ({ ingestStatusline: () => {} }),
    logger: { warn: () => {} },
    ...overrides,
  };
}

async function withApp(overrides: Partial<BackendHttpDependencies>, run: (base: string) => Promise<void>): Promise<void> {
  const server: Server = http.createServer(createBackendHttpApp(appDependencies(overrides)));
  await listenOnLoopback(server);
  try {
    await run(`http://127.0.0.1:${boundPort(server)}`);
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
}

test('the list names only the regular audio files in the sounds directory', async () => {
  const { home, soundsDir } = makeHomeWithSounds();
  try {
    await withApp({ customSoundsDir: soundsDir }, async (base) => {
      const response = await fetch(`${base}/custom-sounds`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { sounds: ['alarm.ogg', 'my chime.mp3'] });
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a missing sounds directory lists no sounds', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-custom-sounds-empty-'));
  try {
    await withApp({ customSoundsDir: path.join(home, 'sounds') }, async (base) => {
      const response = await fetch(`${base}/custom-sounds`);
      assert.deepEqual(await response.json(), { sounds: [] });
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a listed sound is served with its audio content type', async () => {
  const { home, soundsDir } = makeHomeWithSounds();
  try {
    await withApp({ customSoundsDir: soundsDir }, async (base) => {
      const ogg = await fetch(`${base}/custom-sounds/alarm.ogg`);
      assert.equal(ogg.status, 200);
      assert.equal(ogg.headers.get('content-type'), 'audio/ogg');
      assert.equal(ogg.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await ogg.arrayBuffer()), OGG_BYTES);
      const mp3 = await fetch(`${base}/custom-sounds/${encodeURIComponent('my chime.mp3')}`);
      assert.equal(mp3.status, 200);
      assert.equal(mp3.headers.get('content-type'), 'audio/mpeg');
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a byte range request is answered with 206 and just those bytes', async () => {
  const { home, soundsDir } = makeHomeWithSounds();
  try {
    await withApp({ customSoundsDir: soundsDir }, async (base) => {
      const partial = await fetch(`${base}/custom-sounds/alarm.ogg`, { headers: { Range: 'bytes=0-3' } });
      assert.equal(partial.status, 206);
      assert.equal(partial.headers.get('accept-ranges'), 'bytes');
      assert.equal(partial.headers.get('content-range'), `bytes 0-3/${OGG_BYTES.length}`);
      assert.equal(partial.headers.get('content-length'), '4');
      assert.equal(partial.headers.get('content-type'), 'audio/ogg');
      assert.deepEqual(Buffer.from(await partial.arrayBuffer()), OGG_BYTES.subarray(0, 4));
      const suffix = await fetch(`${base}/custom-sounds/alarm.ogg`, { headers: { Range: 'bytes=-5' } });
      assert.equal(suffix.status, 206);
      assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), OGG_BYTES.subarray(OGG_BYTES.length - 5));
      const whole = await fetch(`${base}/custom-sounds/alarm.ogg`, { headers: { Range: 'bytes=0-1,4-5' } });
      assert.equal(whole.status, 200);
      assert.equal(whole.headers.get('accept-ranges'), 'bytes');
      assert.deepEqual(Buffer.from(await whole.arrayBuffer()), OGG_BYTES);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a byte range past the end of the file is answered with 416', async () => {
  const { home, soundsDir } = makeHomeWithSounds();
  try {
    await withApp({ customSoundsDir: soundsDir }, async (base) => {
      const response = await fetch(`${base}/custom-sounds/alarm.ogg`, { headers: { Range: `bytes=${OGG_BYTES.length}-` } });
      assert.equal(response.status, 416);
      assert.equal(response.headers.get('content-range'), `bytes */${OGG_BYTES.length}`);
      assert.equal((await response.arrayBuffer()).byteLength, 0);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('traversal, dotfiles, other extensions, missing files and symlink escapes are all refused', async () => {
  const { home, soundsDir } = makeHomeWithSounds();
  try {
    await withApp({ customSoundsDir: soundsDir }, async (base) => {
      const refusedPaths = [
        '/custom-sounds/notes.txt',
        '/custom-sounds/.hidden.ogg',
        '/custom-sounds/escape.ogg',
        '/custom-sounds/gone.ogg',
        '/custom-sounds/%2e%2e%2fsecret.ogg',
        '/custom-sounds/..%2Fsecret.ogg',
        '/custom-sounds/..%5Csecret.ogg',
      ];
      for (const refusedPath of refusedPaths) {
        const response = await fetch(`${base}${refusedPath}`);
        assert.equal(response.status, 404, refusedPath);
        assert.notEqual(await response.text(), 'outside the sounds dir', refusedPath);
      }
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('remote auth gates the custom sound routes like every other dashboard asset', async () => {
  const { home, soundsDir } = makeHomeWithSounds();
  try {
    const remoteAuth = {
      httpMiddleware: (_request: http.IncomingMessage, response: http.ServerResponse) => {
        response.statusCode = 401;
        response.end('unpaired');
      },
      mountPairRoutes: () => {},
    };
    await withApp({ customSoundsDir: soundsDir, remoteAuth }, async (base) => {
      assert.equal((await fetch(`${base}/custom-sounds`)).status, 401);
      assert.equal((await fetch(`${base}/custom-sounds/alarm.ogg`)).status, 401);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a disallowed host is refused before the custom sound routes', async () => {
  const { home, soundsDir } = makeHomeWithSounds();
  try {
    await withApp({ customSoundsDir: soundsDir }, async (base) => {
      const response = await new Promise<number>((resolve, reject) => {
        const request = http.get(`${base}/custom-sounds`, { headers: { host: 'evil.example' } }, (reply) => {
          reply.resume();
          resolve(reply.statusCode ?? 0);
        });
        request.on('error', reject);
      });
      assert.equal(response, 403);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
