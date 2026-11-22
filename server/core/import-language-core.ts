import path from 'node:path';

export type EmbeddedScriptHost = 'astro' | 'vue' | 'svelte' | 'html' | 'mdx';

type ImportScanner = { kind: 'typescript' } | { kind: 'python' } | { kind: 'embedded'; host: EmbeddedScriptHost };

interface ImportLanguage {
  id: string;
  extensions: readonly string[];
  scanner: ImportScanner;
}

const IMPORT_LANGUAGES: readonly ImportLanguage[] = [
  { id: 'typescript', extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.mts', '.cts'], scanner: { kind: 'typescript' } },
  { id: 'python', extensions: ['.py'], scanner: { kind: 'python' } },
  { id: 'astro', extensions: ['.astro'], scanner: { kind: 'embedded', host: 'astro' } },
  { id: 'vue', extensions: ['.vue'], scanner: { kind: 'embedded', host: 'vue' } },
  { id: 'svelte', extensions: ['.svelte'], scanner: { kind: 'embedded', host: 'svelte' } },
  { id: 'html', extensions: ['.html', '.htm'], scanner: { kind: 'embedded', host: 'html' } },
  { id: 'mdx', extensions: ['.mdx'], scanner: { kind: 'embedded', host: 'mdx' } },
];

const LANGUAGE_BY_EXTENSION = new Map(IMPORT_LANGUAGES.flatMap((language) => language.extensions.map((extension) => [extension, language] as const)));

export function importLanguageOf(repoPath: string): ImportLanguage | null {
  return LANGUAGE_BY_EXTENSION.get(path.posix.extname(repoPath).toLowerCase()) ?? null;
}

export function isSourcePath(repoPath: string): boolean {
  return importLanguageOf(repoPath) !== null;
}
