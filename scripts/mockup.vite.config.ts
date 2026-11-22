import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

import { clock } from '../shared/clock.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stylesheetEntryPath = path.join(repoRoot, 'public', 'tailwind.css');
const IMPORTABLE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.mjs', '.css'];
const packageVersion = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;

function harnessPagesIn(harnessFolder: string): Record<string, string> {
  const pageNames = fs.readdirSync(harnessFolder).filter((fileName) => fileName.endsWith('.html'));
  if (pageNames.length === 0) throw new Error(`no .html harness page in ${harnessFolder}`);
  return Object.fromEntries(pageNames.map((pageName) => [path.parse(pageName).name, path.join(harnessFolder, pageName)]));
}

function escapedHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function buildErrorPage(pageName: string, errorText: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${escapedHtml(pageName)}: build failed</title></head>`
    + '<body style="margin:0;padding:16px;background:#1b1721;color:#f84d4c;font:12px/1.5 ui-monospace,monospace">'
    + `<p style="margin:0 0 8px;font-weight:700">${escapedHtml(pageName)}: build failed</p>`
    + `<pre style="margin:0;white-space:pre-wrap;color:#cfcbd9">${escapedHtml(errorText)}</pre></body></html>`;
}

function isImportable(importedPath: string): boolean {
  return IMPORTABLE_EXTENSIONS.some((extension) => fs.existsSync(`${importedPath}${extension}`));
}

function stylesheetScanningRepoPlugin(): Plugin {
  return {
    name: 'glimmervoid-mockup-stylesheet-scans-repo',
    enforce: 'pre',
    transform(code, id) {
      if (id.split('?')[0] !== stylesheetEntryPath) return null;
      return { code: `${code}\n@source ".";\n`, map: null };
    },
  };
}

function harnessPagesPlugin(): Plugin {
  let pagePathByName: Record<string, string> = {};
  let outFolder = '';
  const importerByMissingPath = new Map<string, string>();
  const missingImportWatchByFolder = new Map<string, fs.FSWatcher>();

  function writeErrorPages(error: Error): void {
    fs.mkdirSync(outFolder, { recursive: true });
    for (const pageName of Object.keys(pagePathByName)) {
      fs.writeFileSync(path.join(outFolder, `${pageName}.html`), buildErrorPage(pageName, stripVTControlCharacters(error.message)));
    }
  }

  function rebuildImportersOfArrivedImports(): void {
    for (const [missingPath, importer] of importerByMissingPath) {
      if (!isImportable(missingPath)) continue;
      importerByMissingPath.delete(missingPath);
      fs.utimesSync(importer, clock.now(), clock.now());
    }
  }

  function watchForMissingImports(): void {
    for (const missingPath of importerByMissingPath.keys()) {
      const folder = path.dirname(missingPath);
      if (missingImportWatchByFolder.has(folder) || !fs.existsSync(folder)) continue;
      missingImportWatchByFolder.set(folder, fs.watch(folder, { persistent: false }, rebuildImportersOfArrivedImports));
    }
  }

  return {
    name: 'glimmervoid-mockup-harness-pages',
    config(config) {
      const harnessFolder = path.resolve(config.root ?? process.cwd());
      pagePathByName = harnessPagesIn(harnessFolder);
      return { build: { rolldownOptions: { input: pagePathByName } } };
    },
    configResolved(resolved) {
      outFolder = path.resolve(resolved.root, resolved.build.outDir);
    },
    buildStart() {
      importerByMissingPath.clear();
    },
    resolveId(source, importer) {
      if (importer === undefined || !source.startsWith('.')) return null;
      const importedPath = path.resolve(path.dirname(importer), source);
      if (!isImportable(importedPath)) importerByMissingPath.set(importedPath, importer);
      return null;
    },
    buildEnd(error) {
      if (!error) return;
      writeErrorPages(error);
      watchForMissingImports();
    },
    renderError(error) {
      writeErrorPages(error);
    },
    closeWatcher() {
      for (const watcher of missingImportWatchByFolder.values()) watcher.close();
      missingImportWatchByFolder.clear();
    },
  };
}

export default defineConfig({
  plugins: [stylesheetScanningRepoPlugin(), tailwindcss(), harnessPagesPlugin()],
  define: { __APP_VERSION__: JSON.stringify(packageVersion) },
  publicDir: false,
  logLevel: 'warn',
  build: { emptyOutDir: true },
});
