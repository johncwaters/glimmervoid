import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import tailwindcss from '@tailwindcss/vite';
import { build, defineConfig } from 'vite';
import type { Plugin, ViteDevServer } from 'vite';

type GlimmervoidBackend = ReturnType<typeof import('./server/backend/backend.ts').createBackend>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')) as { version: string };

const DECK_VIEWER_SOURCE_ID = 'virtual:deck-viewer-source';
const RESOLVED_DECK_VIEWER_SOURCE_ID = `\0${DECK_VIEWER_SOURCE_ID}`;
const DECK_VIEWER_ENTRY = path.resolve(__dirname, 'public/whiteboard/deck-viewer.ts');

async function bundledDeckViewer(): Promise<{ code: string; moduleIds: string[] }> {
  const builds = await build({
    configFile: false,
    root: __dirname,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      write: false,
      minify: true,
      lib: { entry: DECK_VIEWER_ENTRY, formats: ['es'], fileName: 'deck-viewer' },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
  const outputs = (Array.isArray(builds) ? builds : [builds]).flatMap((built) => ('output' in built ? built.output : []));
  const entryChunk = outputs.find((output) => output.type === 'chunk' && output.isEntry);
  if (entryChunk?.type !== 'chunk') throw new Error('the deck viewer build produced no entry chunk');
  return { code: entryChunk.code, moduleIds: entryChunk.moduleIds };
}

function deckViewerSourcePlugin(): Plugin {
  return {
    name: 'glimmervoid-deck-viewer-source',
    resolveId: (id) => (id === DECK_VIEWER_SOURCE_ID ? RESOLVED_DECK_VIEWER_SOURCE_ID : null),
    async load(id) {
      if (id !== RESOLVED_DECK_VIEWER_SOURCE_ID) return null;
      const deckViewer = await bundledDeckViewer();
      for (const moduleId of deckViewer.moduleIds) {
        if (path.isAbsolute(moduleId)) this.addWatchFile(moduleId);
      }
      return `export default ${JSON.stringify(deckViewer.code)};`;
    },
  };
}

function glimmervoidBackendPlugin(): Plugin {
  let backend: GlimmervoidBackend | null = null;

  return {
    name: 'glimmervoid-backend',
    configureServer(server: ViteDevServer) {
      const httpServer = server.httpServer;
      if (!(httpServer instanceof http.Server)) throw new Error('The Glimmervoid dev backend needs Vite\'s plain HTTP server; middleware mode and HTTP/2 have none.');
      const { createBackend, startBackendLinks } = require('./server/backend/backend.ts') as typeof import('./server/backend/backend.ts');
      const devBackend = createBackend(httpServer, {
        staticDir: null,
        localPort: server.config.server.port,
        settingsDefaults: { debugMode: true },
        onRestart: () => {
          console.log('Restart requested - restarting Vite server...');
          server.restart();
        },
      });
      backend = devBackend;
      server.middlewares.use(devBackend.app);
      let remoteServer: http.Server | null = null;
      httpServer.once('listening', () => {
        startBackendLinks(devBackend).then((linkedRemoteServer) => {
          remoteServer = linkedRemoteServer;
        }).catch((error: unknown) => {
          console.error(`Glimmervoid dev backend links did not start: ${error instanceof Error ? error.message : String(error)}`);
        });
      });

      httpServer.on('close', () => {
        remoteServer?.closeAllConnections();
        remoteServer?.close();
        devBackend.shutdown();
      });

      process.on('SIGINT', () => {
        if (backend) backend.shutdown();
      });
    },
  };
}

const brotliCompress = promisify(zlib.brotliCompress);
const BROTLI_EXTENSIONS = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt']);
const MIN_BROTLI_BYTES = 1024;
const FLYING_ANIMAL_SPRITE_PATH = /[\\/]public[\\/]animals[\\/][^\\/]+\.png$/;

function brotliOutputPlugin(): Plugin {
  let outDir = '';
  return {
    name: 'glimmervoid-brotli',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const entries = await fs.promises.readdir(outDir, { recursive: true, withFileTypes: true });
      const compressibleFiles = entries
        .filter((entry) => entry.isFile() && BROTLI_EXTENSIONS.has(path.extname(entry.name)))
        .map((entry) => path.join(entry.parentPath, entry.name));
      await Promise.all(compressibleFiles.map(async (filePath) => {
        const original = await fs.promises.readFile(filePath);
        if (original.length < MIN_BROTLI_BYTES) return;
        const compressed = await brotliCompress(original, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: original.length } });
        await fs.promises.writeFile(`${filePath}.br`, compressed);
      }));
    },
  };
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    glimmervoidBackendPlugin(),
    deckViewerSourcePlugin(),
    brotliOutputPlugin(),
  ],

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  worker: {
    format: 'es',
  },

  root: 'public',

  publicDir: '../assets',

  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    manifest: true,
    chunkSizeWarningLimit: 750,
    assetsInlineLimit: (filePath) => (FLYING_ANIMAL_SPRITE_PATH.test(filePath) ? false : undefined),
    rolldownOptions: {
      input: {
        index: path.resolve(__dirname, 'public/index.html'),
        'service-worker': path.resolve(__dirname, 'public/service-worker.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'service-worker' ? 'service-worker.js' : 'assets/[name]-[hash].js'),
        codeSplitting: {
          groups: [
            { name: 'xterm', test: /node_modules[\\/]@xterm[\\/]/ },
            { name: 'zod', test: /node_modules[\\/]zod[\\/]/ },
          ],
        },
      },
    },
  },

  server: {
    fs: {
      allow: [__dirname],
    },
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
