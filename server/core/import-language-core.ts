import path from 'node:path';

export type EmbeddedScriptHost = 'astro' | 'vue' | 'svelte' | 'html' | 'mdx';

export interface GrammarScanner {
  kind: 'grammar';
  grammar: string;
  importNodeTypes: readonly string[];
  isTopLevelOnly: boolean;
  importQuery: string;
  importSection: ImportSection | null;
}

interface ImportSection {
  kind: 'throughLastMatch' | 'matchesOnly';
  pattern: RegExp;
}

type ImportScanner = { kind: 'typescript' } | { kind: 'python' } | { kind: 'embedded'; host: EmbeddedScriptHost } | GrammarScanner;

type ImportResolver =
  | { kind: 'file' }
  | { kind: 'candidates'; manifestName: string | null }
  | { kind: 'packageDirectory'; manifestName: string; excludedTargetPattern: RegExp | null; isRecursive: boolean }
  | { kind: 'declaredNamespace'; family: string };

interface ImportLanguage {
  id: string;
  extensions: readonly string[];
  scanner: ImportScanner;
  resolver: ImportResolver;
}

const FILE_RESOLVER: ImportResolver = { kind: 'file' };
const CANDIDATE_RESOLVER: ImportResolver = { kind: 'candidates', manifestName: null };
const PHP_INCLUDE_TYPES = ['require_expression', 'require_once_expression', 'include_expression', 'include_once_expression'];
const JVM_HEADER_SECTION: ImportSection = { kind: 'throughLastMatch', pattern: /^[ \t]*(?:package|import)\b[^\n]*/gm };
const SCALA_IMPORT_STATEMENTS: ImportSection = {
  kind: 'matchesOnly',
  pattern: /"""[\s\S]*?(?:"""|$(?![\s\S]))|"(?:[^"\\\n]|\\.)*\\?(?:"|$)|'(?:[^'\\\n]|\\.)'|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$(?![\s\S]))|^[ \t]*(package\b[^\n{]*|import\b[^\n{]*(?:\{[^{}]{0,1024}\}[^\n]*)?)/gm,
};
const JVM_RESOLVER: ImportResolver = { kind: 'declaredNamespace', family: 'jvm' };
const ELIXIR_IMPORT_QUERY = [
  '(call target: (identifier) @directive (arguments . (_) @elixir_alias) (#match? @directive "^(alias|import|use|require)$"))',
  '(call target: (dot left: (alias) @specifier))',
  '(call target: (identifier) @directive (arguments . (alias) @declares) (#match? @directive "^(defmodule|defprotocol)$"))',
].join(' ');

const PHP_IMPORT_QUERY = [
  '(namespace_use_declaration) @php_use',
  ...PHP_INCLUDE_TYPES.flatMap((includeType) => [
    `(${includeType} [(string) (encapsed_string)] @specifier)`,
    `(${includeType} (binary_expression left: (name) @directory right: [(string) (encapsed_string)] @relative) (#eq? @directory "__DIR__"))`,
  ]),
].join(' ');

function grammarScanner(grammar: string, importNodeTypes: readonly string[], importQuery: string): GrammarScanner {
  return { kind: 'grammar', grammar, importNodeTypes, isTopLevelOnly: false, importQuery, importSection: null };
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
      importSection: null,
    },
    resolver: { kind: 'packageDirectory', manifestName: 'go.mod', excludedTargetPattern: /_test[.]go$/, isRecursive: false },
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
  {
    id: 'rust',
    extensions: ['.rs'],
    scanner: {
      ...grammarScanner(
        'rust',
        ['mod_item', 'use_declaration', 'extern_crate_declaration'],
        '(mod_item !body name: (identifier) @relative) (use_declaration argument: (_) @rust_use_tree) (extern_crate_declaration name: (identifier) @specifier)',
      ),
      isTopLevelOnly: true,
    },
    resolver: { kind: 'candidates', manifestName: 'Cargo.toml' },
  },
  {
    id: 'dart',
    extensions: ['.dart'],
    scanner: {
      ...grammarScanner(
        'dart',
        ['import_or_export', 'part_directive'],
        '(import_or_export (library_import (import_specification (configurable_uri . (uri (string_literal) @specifier))))) (import_or_export (library_export (configurable_uri . (uri (string_literal) @specifier)))) (part_directive (uri (string_literal) @specifier))',
      ),
      isTopLevelOnly: true,
    },
    resolver: { kind: 'candidates', manifestName: 'pubspec.yaml' },
  },
  { id: 'php', extensions: ['.php'], scanner: grammarScanner('php', ['namespace_use_declaration', ...PHP_INCLUDE_TYPES], PHP_IMPORT_QUERY), resolver: { kind: 'candidates', manifestName: 'composer.json' } },
  {
    id: 'csharp',
    extensions: ['.cs'],
    scanner: grammarScanner(
      'c-sharp',
      ['using_directive', 'namespace_declaration', 'file_scoped_namespace_declaration'],
      '(using_directive (_) @specifier .) (namespace_declaration name: (_) @declares) (file_scoped_namespace_declaration name: (_) @declares)',
    ),
    resolver: { kind: 'declaredNamespace', family: 'dotnet' },
  },
  {
    id: 'java',
    extensions: ['.java'],
    scanner: {
      ...grammarScanner('java', ['package_declaration', 'import_declaration'], '(package_declaration [(scoped_identifier) (identifier)] @declares) (import_declaration [(scoped_identifier) (identifier)] @specifier)'),
      isTopLevelOnly: true,
      importSection: JVM_HEADER_SECTION,
    },
    resolver: JVM_RESOLVER,
  },
  {
    id: 'kotlin',
    extensions: ['.kt', '.kts'],
    scanner: { ...grammarScanner('kotlin', ['package_header', 'import_header'], '(package_header (identifier) @declares) (import_header (identifier) @specifier)'), importSection: JVM_HEADER_SECTION },
    resolver: JVM_RESOLVER,
  },
  {
    id: 'scala',
    extensions: ['.scala', '.sc'],
    scanner: { ...grammarScanner('scala', ['package_clause', 'import_declaration'], '(package_clause name: (package_identifier) @declares) (import_declaration) @scala_import'), importSection: SCALA_IMPORT_STATEMENTS },
    resolver: JVM_RESOLVER,
  },
  { id: 'elixir', extensions: ['.ex', '.exs'], scanner: grammarScanner('elixir', ['call'], ELIXIR_IMPORT_QUERY), resolver: { kind: 'declaredNamespace', family: 'elixir' } },
];

export const IMPORT_LANGUAGE_IDS: readonly string[] = [...new Set(IMPORT_LANGUAGES.map((language) => language.id))].sort();

export const IMPORT_GRAMMAR_NAMES: readonly string[] = [...new Set(IMPORT_LANGUAGES.flatMap((language) => (language.scanner.kind === 'grammar' ? [language.scanner.grammar] : [])))];

const LANGUAGE_BY_EXTENSION = new Map(IMPORT_LANGUAGES.flatMap((language) => language.extensions.map((extension) => [extension, language] as const)));

const IMPORT_MANIFEST_NAMES: ReadonlySet<string> = new Set(IMPORT_LANGUAGES.flatMap((language) => ('manifestName' in language.resolver && language.resolver.manifestName ? [language.resolver.manifestName] : [])));

export function importLanguageOf(repoPath: string): ImportLanguage | null {
  return LANGUAGE_BY_EXTENSION.get(path.posix.extname(repoPath).toLowerCase()) ?? null;
}

export function isSourcePath(repoPath: string): boolean {
  return importLanguageOf(repoPath) !== null;
}

export function isImportManifestPath(repoPath: string): boolean {
  return IMPORT_MANIFEST_NAMES.has(path.posix.basename(repoPath));
}
