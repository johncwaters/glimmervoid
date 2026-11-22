import path from 'node:path';

import { nearestPackage, packagePrefixMatches, packagesNamed } from './manifest-prefix.ts';
import type { ManifestPackageIndex } from './manifest-prefix.ts';

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
const RUST_PATH_SEPARATOR = '::';
const MAX_RUST_MODULE_DEPTH = 8;
const DART_PACKAGE_URI = /^package:([^/]+)\/(.+)$/;
const PHP_NAMESPACE_SEPARATOR = '\\';

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

function rustModuleDirectoryOf(fromPath: string): string {
  const directory = path.posix.dirname(fromPath);
  return RUST_DIRECTORY_MODULE_FILES.has(path.posix.basename(fromPath)) ? directory : path.posix.join(directory, path.posix.basename(fromPath, '.rs'));
}

function rustPathCandidates(base: string, segments: readonly string[], rootFile: string | null): FileCandidates {
  const modulePaths: string[] = [];
  for (const segment of segments.slice(0, MAX_RUST_MODULE_DEPTH)) modulePaths.push(path.posix.join(modulePaths.at(-1) ?? base, segment));
  const paths = modulePaths.reverse().flatMap((modulePath) => [`${modulePath}.rs`, path.posix.join(modulePath, 'mod.rs')]);
  return { paths: rootFile ? [...paths, rootFile] : paths, suffixes: [] };
}

function rustUseCandidates(fromPath: string, specifier: string, packages: ManifestPackageIndex): FileCandidates {
  const [head, ...rest] = specifier.split(RUST_PATH_SEPARATOR);
  if (head === 'crate') {
    const ownCrate = nearestPackage(packages, 'Cargo.toml', fromPath);
    return ownCrate ? rustPathCandidates(ownCrate.sourceDirectory, rest, null) : NO_CANDIDATES;
  }
  if (head === 'self') return rustPathCandidates(rustModuleDirectoryOf(fromPath), rest, null);
  if (head === 'super') {
    const segments = [head, ...rest];
    const superCount = segments.findIndex((segment) => segment !== 'super');
    if (superCount === -1) return NO_CANDIDATES;
    const base = segments.slice(0, superCount).reduce((directory) => path.posix.dirname(directory), rustModuleDirectoryOf(fromPath));
    return rustPathCandidates(base, segments.slice(superCount), null);
  }
  const crates = packagesNamed(packages, 'Cargo.toml', head);
  return { paths: crates.flatMap((crate) => rustPathCandidates(crate.sourceDirectory, rest, crate.rootFile).paths), suffixes: [] };
}

function rustCandidates(fromPath: string, specifier: string, packages: ManifestPackageIndex): FileCandidates {
  return specifier.startsWith('./') ? rustModuleCandidates(fromPath, specifier.slice(2)) : rustUseCandidates(fromPath, specifier, packages);
}

function dartCandidates(fromPath: string, specifier: string, packages: ManifestPackageIndex): FileCandidates {
  const packageUri = DART_PACKAGE_URI.exec(specifier);
  if (packageUri) return { paths: packagesNamed(packages, 'pubspec.yaml', packageUri[1]).map((dartPackage) => path.posix.join(dartPackage.sourceDirectory, packageUri[2])), suffixes: [] };
  return URL_SCHEME.test(specifier) || specifier.startsWith('/') ? NO_CANDIDATES : { paths: [besideFile(fromPath, specifier)], suffixes: [] };
}

function phpCandidates(fromPath: string, specifier: string, packages: ManifestPackageIndex): FileCandidates {
  if (specifier.startsWith(PHP_NAMESPACE_SEPARATOR)) {
    const matches = packagePrefixMatches(packages, 'composer.json', specifier.slice(PHP_NAMESPACE_SEPARATOR.length));
    return { paths: matches.filter(({ remainder }) => remainder.length > 0).map(({ manifestPackage, remainder }) => `${path.posix.join(manifestPackage.sourceDirectory, ...remainder)}.php`), suffixes: [] };
  }
  if (specifier.includes('$') || URL_SCHEME.test(specifier) || path.posix.isAbsolute(specifier)) return NO_CANDIDATES;
  return { paths: [besideFile(fromPath, specifier)], suffixes: [] };
}

function shellCandidates(fromPath: string, specifier: string): FileCandidates {
  const scriptDirectoryMatch = SCRIPT_DIRECTORY_PREFIX.exec(specifier);
  const variableName = scriptDirectoryMatch?.[1];
  const scriptRelative = variableName === undefined || DIRECTORY_VARIABLE_NAME.test(variableName) ? scriptDirectoryMatch?.[2] : undefined;
  if (scriptRelative !== undefined) return scriptRelative.includes('$') ? NO_CANDIDATES : { paths: [besideFile(fromPath, scriptRelative)], suffixes: [] };
  if (specifier.includes('$') || path.posix.isAbsolute(specifier)) return NO_CANDIDATES;
  return { paths: [besideFile(fromPath, specifier), specifier], suffixes: [] };
}

function candidatesOf(languageId: string, fromPath: string, specifier: string, packages: ManifestPackageIndex): FileCandidates {
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
      return rustCandidates(fromPath, specifier, packages);
    case 'dart':
      return dartCandidates(fromPath, specifier, packages);
    case 'php':
      return phpCandidates(fromPath, specifier, packages);
    default:
      return NO_CANDIDATES;
  }
}

function isInsideRepo(candidatePath: string): boolean {
  return candidatePath !== '..' && !candidatePath.startsWith('../') && !path.posix.isAbsolute(candidatePath);
}

export function fileCandidatesOf(languageId: string, fromPath: string, specifier: string, packages: ManifestPackageIndex): FileCandidates {
  const { paths, suffixes } = candidatesOf(languageId, fromPath, specifier, packages);
  return { paths: paths.map((candidatePath) => path.posix.normalize(candidatePath)).filter(isInsideRepo), suffixes: suffixes.map((suffix) => path.posix.normalize(suffix)).filter(isInsideRepo) };
}
