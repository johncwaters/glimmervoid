import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import type { Plugin, ViteDevServer } from 'vite';

type GlimmervoidBackend = ReturnType<typeof import('./server/backend/backend.ts').createBackend>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')) as { version: string };

function glimmervoidBackendPlugin(): Plugin {
  let backend: GlimmervoidBackend | null = null;

  return {
    name: 'glimmervoid-backend',
    configureServer(server: ViteDevServer) {
      const httpServer = server.httpServer;
      if (!(httpServer instanceof http.Server)) throw new Error('The Glimmervoid dev backend needs Vite\'s plain HTTP server; middleware mode and HTTP/2 have none.');
      const { createBackend } = require('./server/backend/backend.ts') as typeof import('./server/backend/backend.ts');
      backend = createBackend(httpServer, {
        staticDir: null,
        settingsDefaults: { debugMode: true },
        onRestart: () => {
          console.log('Restart requested - restarting Vite server...');
          server.restart();
        },
      });
      server.middlewares.use(backend.app);

      httpServer.on('close', () => {
        if (backend) backend.shutdown();
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
    brotliOutputPlugin(),
  ],

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  root: 'public',

  publicDir: '../assets',

  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    manifest: true,
    chunkSizeWarningLimit: 750,
    rolldownOptions: {
      output: {
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
  },
});
