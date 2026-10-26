import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(repoRoot, 'dist');

const REQUIRED_OUTPUTS = [
  'client/index.html',
  'server/index.js',
  'bin/glimmervoid.js',
  'session/hook-relay.js',
  'session/command-hook-relay.js',
  'session/statusline-relay.js',
  'session/hook-tool-relay.js',
  'session/visions-relay.js',
  'session/guardrails-open-launcher.js',
  'session/remote-setup/SKILL.md',
  'session/remote-setup/glimmervoid.service',
  'scripts/postinstall-path-check.js',
  'tools/vscode-visions/extension.js',
  'tools/vscode-visions/lsp-convert.js',
  'tools/vscode-visions/visions-lsp-core.js',
  'tools/vscode-visions/package.json',
];

function fail(message) {
  console.error(`build: ${message}`);
  process.exit(1);
}

function nodeOutputFiles(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'client') nodeOutputFiles(absolutePath, found);
      continue;
    }
    if (entry.name.endsWith('.js')) found.push(absolutePath);
  }
  return found;
}

function assertImportMetaSurvived() {
  const resolvers = nodeOutputFiles(distDir)
    .map((filePath) => ({ filePath, source: fs.readFileSync(filePath, 'utf8') }))
    .filter((file) => file.source.includes('computeRuntimePaths('));
  if (resolvers.length === 0) fail('no dist/ output calls computeRuntimePaths: the runtime path resolver was tree-shaken away');
  for (const resolver of resolvers) {
    if (resolver.source.includes('import.meta.url')) continue;
    fail(`${path.relative(distDir, resolver.filePath)} calls computeRuntimePaths with no import.meta.url left: the ES-format SSR output rewrote it`);
  }
}

function assertLazyViewsStayOutOfEntry() {
  const viteMetadataDir = path.join(distDir, 'client', '.vite');
  const manifest = JSON.parse(fs.readFileSync(path.join(viteMetadataDir, 'manifest.json'), 'utf8'));
  fs.rmSync(viteMetadataDir, { recursive: true, force: true });
  const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry);
  if (!entryKey) fail('the client manifest names no entry chunk');
  const staticallyReachedFiles = new Set();
  const pendingKeys = [entryKey];
  while (pendingKeys.length > 0) {
    const chunk = manifest[pendingKeys.pop()];
    if (!chunk || staticallyReachedFiles.has(chunk.file)) continue;
    staticallyReachedFiles.add(chunk.file);
    pendingKeys.push(...(chunk.imports ?? []));
  }
  const registrySource = fs.readFileSync(path.join(repoRoot, 'public', 'view-registry.ts'), 'utf8');
  const lazyViewSources = [...registrySource.matchAll(/import\('\.\/([^']+)'\)/g)].map((match) => match[1]);
  if (lazyViewSources.length === 0) fail('public/view-registry.ts loads no view through load()');
  for (const source of lazyViewSources) {
    const chunk = manifest[source];
    if (!chunk?.isDynamicEntry || staticallyReachedFiles.has(chunk.file)) fail(`public/${source} is statically reachable from the entry chunk; import its store instead of the panel`);
  }
}

fs.rmSync(distDir, { recursive: true, force: true });

await build({ configFile: path.join(repoRoot, 'vite.config.ts') });
assertLazyViewsStayOutOfEntry();
await build({ configFile: path.join(repoRoot, 'vite.server.config.ts') });
assertImportMetaSurvived();
await build({ configFile: path.join(repoRoot, 'vite.extension.config.ts') });

fs.cpSync(path.join(repoRoot, 'session', 'remote-setup'), path.join(distDir, 'session', 'remote-setup'), { recursive: true });

fs.writeFileSync(path.join(distDir, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

const missing = REQUIRED_OUTPUTS.filter((relativePath) => !fs.existsSync(path.join(distDir, relativePath)));
if (missing.length > 0) fail(`missing from dist/: ${missing.join(', ')}`);

const declaredBin = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).bin;
const declaredBins = typeof declaredBin === 'string' ? [declaredBin] : Object.values(declaredBin ?? {});
for (const relativePath of declaredBins) fs.chmodSync(path.join(repoRoot, relativePath), 0o755);

console.log(`build: dist/ complete (${REQUIRED_OUTPUTS.length} load-bearing outputs present)`);
