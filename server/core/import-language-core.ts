import path from 'node:path';

export type EmbeddedScriptHost = 'astro' | 'vue' | 'svelte' | 'html' | 'mdx';

export interface GrammarScanner {
  kind: 'grammar';
  grammar: string;
  importNodeTypes: readonly string[];
  isTopLevelOnly: boolean;
  importQuery: string;
}

type ImportScanner = { kind: 'typescript' } | { kind: 'python' } | { kind: 'embedded'; host: EmbeddedScriptHost } | GrammarScanner;

type ImportResolver = { kind: 'file' } | { kind: 'candidates' } | { kind: 'packageDirectory'; manifestName: string; excludedTargetPattern: RegExp };

interface ImportLanguage {
  id: string;
  extensions: readonly string[];
  scanner: ImportScanner;
  resolver: ImportResolver;
}

const FILE_RESOLVER: ImportResolver = { kind: 'file' };
const CANDIDATE_RESOLVER: ImportResolver = { kind: 'candidates' };

function grammarScanner(grammar: string, importNodeTypes: readonly string[], importQuery: string): GrammarScanner {
  return { kind: 'grammar', grammar, importNodeTypes, isTopLevelOnly: false, importQuery };
}

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
    scanner: {
      kind: 'grammar',
      grammar: 'go',
      importNodeTypes: ['import_declaration'],
      isTopLevelOnly: true,
      importQuery: '(import_declaration [(import_spec path: (_) @specifier) (import_spec_list (import_spec path: (_) @specifier))])',
    },
    resolver: { kind: 'packageDirectory', manifestName: 'go.mod', excludedTargetPattern: /_test[.]go$/ },
  },
  { id: 'c', extensions: ['.c', '.h'], scanner: grammarScanner('c', ['preproc_include'], '(preproc_include path: (string_literal) @specifier)'), resolver: CANDIDATE_RESOLVER },
  {
    id: 'cpp',
    extensions: ['.cc', '.cpp', '.cxx', '.c++', '.hh', '.hpp', '.hxx', '.h++', '.ipp', '.inl'],
    scanner: grammarScanner('cpp', ['preproc_include'], '(preproc_include path: (string_literal) @specifier)'),
    resolver: CANDIDATE_RESOLVER,
  },
  {
    id: 'shell',
    extensions: ['.sh', '.bash'],
    scanner: grammarScanner('bash', ['command'], '(command name: (command_name) @command . argument: (_) @specifier (#match? @command "^(source|[.])$"))'),
    resolver: CANDIDATE_RESOLVER,
  },
  {
    id: 'zig',
    extensions: ['.zig'],
    scanner: grammarScanner('zig', ['builtin_function'], '(builtin_function (builtin_identifier) @function (arguments . (string) @specifier) (#eq? @function "@import"))'),
    resolver: CANDIDATE_RESOLVER,
  },
  { id: 'solidity', extensions: ['.sol'], scanner: grammarScanner('solidity', ['import_directive'], '(import_directive source: (string) @specifier)'), resolver: CANDIDATE_RESOLVER },
  {
    id: 'css',
    extensions: ['.css'],
    scanner: grammarScanner('css', ['import_statement'], '[(import_statement . (string_value) @specifier) (import_statement . (call_expression (arguments . (_) @specifier)))]'),
    resolver: CANDIDATE_RESOLVER,
  },
  {
    id: 'ruby',
    extensions: ['.rb'],
    scanner: grammarScanner(
      'ruby',
      ['call'],
      '(call !receiver method: (identifier) @function arguments: (argument_list . (string . (string_content) @specifier .)) (#eq? @function "require")) (call !receiver method: (identifier) @function arguments: (argument_list . (string . (string_content) @relative .)) (#eq? @function "require_relative"))',
    ),
    resolver: CANDIDATE_RESOLVER,
  },
  { id: 'rust', extensions: ['.rs'], scanner: { ...grammarScanner('rust', ['mod_item'], '(mod_item !body name: (identifier) @specifier)'), isTopLevelOnly: true }, resolver: CANDIDATE_RESOLVER },
];

export const IMPORT_GRAMMAR_NAMES: readonly string[] = [...new Set(IMPORT_LANGUAGES.flatMap((language) => (language.scanner.kind === 'grammar' ? [language.scanner.grammar] : [])))];

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
