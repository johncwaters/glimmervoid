import path from 'node:path';

export type EmbeddedScriptHost = 'astro' | 'vue' | 'svelte' | 'html' | 'mdx';

export interface GrammarScanner {
  kind: 'grammar';
  grammar: string;
  importNodeTypes: readonly string[];
  maxImportDepth: number;
  importQuery: string;
}

type ImportScanner = { kind: 'typescript' } | { kind: 'python' } | { kind: 'embedded'; host: EmbeddedScriptHost } | GrammarScanner;

type ImportResolver = { kind: 'file' } | { kind: 'packageDirectory'; manifestName: string; excludedTargetPattern: RegExp };

interface ImportLanguage {
  id: string;
  extensions: readonly string[];
  scanner: ImportScanner;
  resolver: ImportResolver;
}

const FILE_RESOLVER: ImportResolver = { kind: 'file' };

const IMPORT_LANGUAGES: readonly ImportLanguage[] = [
  { id: 'typescript', extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.mts', '.cts'], scanner: { kind: 'typescript' }, resolver: FILE_RESOLVER },
  { id: 'python', extensions: ['.py'], scanner: { kind: 'python' }, resolver: FILE_RESOLVER },
  { id: 'astro', extensions: ['.astro'], scanner: { kind: 'embedded', host: 'astro' }, resolver: FILE_RESOLVER },
  { id: 'vue', extensions: ['.vue'], scanner: { kind: 'embedded', host: 'vue' }, resolver: FILE_RESOLVER },
  { id: 'svelte', extensions: ['.svelte'], scanner: { kind: 'embedded', host: 'svelte' }, resolver: FILE_RESOLVER },
  { id: 'html', extensions: ['.html', '.htm'], scanner: { kind: 'embedded', host: 'html' }, resolver: FILE_RESOLVER },
  { id: 'mdx', extensions: ['.mdx'], scanner: { kind: 'embedded', host: 'mdx' }, resolver: FILE_RESOLVER },
  {
    id: 'go',
    extensions: ['.go'],
    scanner: { kind: 'grammar', grammar: 'go', importNodeTypes: ['import_declaration'], maxImportDepth: 1, importQuery: '(import_spec path: (_) @specifier)' },
    resolver: { kind: 'packageDirectory', manifestName: 'go.mod', excludedTargetPattern: /_test[.]go$/ },
  },
];

const LANGUAGE_BY_EXTENSION = new Map(IMPORT_LANGUAGES.flatMap((language) => language.extensions.map((extension) => [extension, language] as const)));

const IMPORT_MANIFEST_NAMES: ReadonlySet<string> = new Set(IMPORT_LANGUAGES.flatMap((language) => (language.resolver.kind === 'packageDirectory' ? [language.resolver.manifestName] : [])));

export function importLanguageOf(repoPath: string): ImportLanguage | null {
  return LANGUAGE_BY_EXTENSION.get(path.posix.extname(repoPath).toLowerCase()) ?? null;
}

export function isSourcePath(repoPath: string): boolean {
  return importLanguageOf(repoPath) !== null;
}

export function isImportManifestPath(repoPath: string): boolean {
  return IMPORT_MANIFEST_NAMES.has(path.posix.basename(repoPath));
}
