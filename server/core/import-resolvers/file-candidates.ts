import path from 'node:path';

interface FileCandidates {
  paths: string[];
  suffixes: string[];
}

const NO_CANDIDATES: FileCandidates = { paths: [], suffixes: [] };
const RUST_DIRECTORY_MODULE_FILES = new Set(['mod.rs', 'lib.rs', 'main.rs']);
const SCRIPT_DIRECTORY_PREFIX = /^"?(?:\$\(dirname [^)]*\)|\$\{BASH_SOURCE[^}]*\}|\$\{?([A-Za-z_]\w*)\}?)"?\/(.+)$/;
const DIRECTORY_VARIABLE_NAME = /dir/i;
const RUBY_LOAD_PATH_ROOTS = ['lib', 'test', 'spec'];
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const PACKAGE_SCOPE_PREFIX = /^@[^/]+\/[^/]+\//;

function besideFile(fromPath: string, relativePath: string): string {
  return path.posix.join(path.posix.dirname(fromPath), relativePath);
}

function withExtension(modulePath: string, extension: string): string {
  return path.posix.extname(modulePath) ? modulePath : `${modulePath}${extension}`;
}

function rustModuleCandidates(fromPath: string, moduleName: string): FileCandidates {
  const directory = path.posix.dirname(fromPath);
  const ownDirectory = path.posix.join(directory, path.posix.basename(fromPath, '.rs'));
  const bases = RUST_DIRECTORY_MODULE_FILES.has(path.posix.basename(fromPath)) ? [directory, ownDirectory] : [ownDirectory, directory];
  return { paths: bases.flatMap((base) => [path.posix.join(base, `${moduleName}.rs`), path.posix.join(base, moduleName, 'mod.rs')]), suffixes: [] };
}

function shellCandidates(fromPath: string, specifier: string): FileCandidates {
  const scriptDirectoryMatch = SCRIPT_DIRECTORY_PREFIX.exec(specifier);
  const variableName = scriptDirectoryMatch?.[1];
  const scriptRelative = variableName === undefined || DIRECTORY_VARIABLE_NAME.test(variableName) ? scriptDirectoryMatch?.[2] : undefined;
  if (scriptRelative !== undefined) return scriptRelative.includes('$') ? NO_CANDIDATES : { paths: [besideFile(fromPath, scriptRelative)], suffixes: [] };
  if (specifier.includes('$') || path.posix.isAbsolute(specifier)) return NO_CANDIDATES;
  return { paths: [besideFile(fromPath, specifier), specifier], suffixes: [] };
}

function candidatesOf(languageId: string, fromPath: string, specifier: string): FileCandidates {
  switch (languageId) {
    case 'c':
    case 'cpp':
      return { paths: [besideFile(fromPath, specifier)], suffixes: specifier.startsWith('.') ? [] : [specifier] };
    case 'shell':
      return shellCandidates(fromPath, specifier);
    case 'zig':
      return specifier.endsWith('.zig') ? { paths: [besideFile(fromPath, specifier)], suffixes: [] } : NO_CANDIDATES;
    case 'solidity':
      if (specifier.startsWith('.')) return { paths: [besideFile(fromPath, specifier)], suffixes: [] };
      return { paths: [specifier], suffixes: [specifier, specifier.replace(PACKAGE_SCOPE_PREFIX, '')] };
    case 'css':
      return URL_SCHEME.test(specifier) || specifier.startsWith('/') ? NO_CANDIDATES : { paths: [besideFile(fromPath, specifier)], suffixes: [] };
    case 'ruby':
      if (specifier.startsWith('.')) return { paths: [besideFile(fromPath, withExtension(specifier, '.rb'))], suffixes: [] };
      return { paths: [], suffixes: RUBY_LOAD_PATH_ROOTS.map((root) => `${root}/${withExtension(specifier, '.rb')}`) };
    case 'rust':
      return rustModuleCandidates(fromPath, specifier);
    default:
      return NO_CANDIDATES;
  }
}

function isInsideRepo(candidatePath: string): boolean {
  return candidatePath !== '..' && !candidatePath.startsWith('../') && !path.posix.isAbsolute(candidatePath);
}

export function fileCandidatesOf(languageId: string, fromPath: string, specifier: string): FileCandidates {
  const { paths, suffixes } = candidatesOf(languageId, fromPath, specifier);
  return { paths: paths.map((candidatePath) => path.posix.normalize(candidatePath)).filter(isInsideRepo), suffixes: suffixes.map((suffix) => path.posix.normalize(suffix)).filter(isInsideRepo) };
}
