
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

function isExternal(id: string): boolean {
  if (id.startsWith('#')) return false;
  if (id.startsWith('.')) return false;
  return !path.isAbsolute(id);
}

export default defineConfig({
  root: repoRoot,
  publicDir: false,
  resolve: {
    alias: [{ find: /^#shared\//, replacement: `${path.join(repoRoot, 'shared')}/` }],
  },
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'dist',
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    rolldownOptions: {
      external: isExternal,
      input: {
        'server/index': path.join(repoRoot, 'server', 'index.ts'),
        'bin/glimmervoid': path.join(repoRoot, 'bin', 'glimmervoid.ts'),
        'session/hook-relay': path.join(repoRoot, 'session', 'hook-relay.ts'),
        'session/command-hook-relay': path.join(repoRoot, 'session', 'command-hook-relay.ts'),
        'session/statusline-relay': path.join(repoRoot, 'session', 'statusline-relay.ts'),
        'session/hook-tool-relay': path.join(repoRoot, 'session', 'hook-tool-relay.ts'),
        'session/visions-relay': path.join(repoRoot, 'session', 'visions-relay.ts'),
        'scripts/postinstall-path-check': path.join(repoRoot, 'scripts', 'postinstall-path-check.ts'),
      },
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
});
