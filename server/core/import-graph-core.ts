import path from 'node:path';
import { matchPathPatterns } from './tsconfig-paths-core.ts';
import {
  CHANGE_MAP_LIST_CAP,
  changeMapFactId,
  type BlastRadiusFact,
  type UntestedFileFact,
} from '../../shared/contracts/change-map.ts';

export const CALL_IMPORT = /\b(?:require|import)\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
export const STATIC_IMPORT = /\bimport\b(?:(?:(?!\b(?:import|export)\b)[^'";])*?\bfrom)?\s*(['"])([^'"]+)\1/g;
const EXPORT_FROM = /\bexport\b(?:(?!\b(?:import|export)\b)[^'";])*?\bfrom\s*(['"])([^'"]+)\1/g;

export interface ImportGraph {
  dependentsByPath: Map<string, Set<string>>;
}

export function extractImportSpecifiers(sourceText: string): string[] {
  const matches: { index: number; specifier: string }[] = [];
  for (const pattern of [CALL_IMPORT, STATIC_IMPORT, EXPORT_FROM]) {
    pattern.lastIndex = 0;
    for (const match of sourceText.matchAll(pattern)) {
      matches.push({ index: match.index, specifier: match[2] });
    }
  }

  matches.sort((left, right) => left.index - right.index);
  return [...new Set(matches.map((match) => match.specifier))];
}

export function extractPythonImportSpecifiers(sourceText: string): string[] {
  const specifiers: string[] = [];
  let pendingFrom = '';
  let pendingNames = '';
  let stringQuote = '';
  let isTripleString = false;
  for (const originalLine of sourceText.split('\n')) {
    let line = '';
    for (let index = 0; index < originalLine.length; index++) {
      const character = originalLine[index];
      if (stringQuote) {
        if (character === '\\') { index++; continue; }
        if (isTripleString && originalLine.slice(index, index + 3) === stringQuote.repeat(3)) {
          index += 2;
          stringQuote = '';
          isTripleString = false;
          continue;
        }
        if (!isTripleString && character === stringQuote) stringQuote = '';
        continue;
      }
      if (character === '#') break;
      if (character === '"' || character === "'") {
        stringQuote = character;
        isTripleString = originalLine.slice(index, index + 3) === character.repeat(3);
        if (isTripleString) index += 2;
        continue;
      }
      line += character;
    }
    const trimmed = line.trim();
    if (pendingFrom) {
      pendingNames += trimmed;
      if (!trimmed.includes(')')) continue;
      specifiers.push(...fromImportSpecifiers(pendingFrom, pendingNames));
      pendingFrom = '';
      pendingNames = '';
      continue;
    }
    if (trimmed.startsWith('import ')) {
      for (const name of trimmed.slice(7).split(',')) {
        const importedName = name.trim().split(/\s+/)[0];
        if (importedName) specifiers.push(importedName);
      }
      continue;
    }
    if (!trimmed.startsWith('from ')) continue;
    const importIndex = trimmed.indexOf(' import ');
    if (importIndex < 0) continue;
    const moduleName = trimmed.slice(5, importIndex).trim();
    if (!moduleName) continue;
    const names = trimmed.slice(importIndex + 8);
    if (names.includes('(') && !names.includes(')')) {
      pendingFrom = moduleName;
      pendingNames = names;
      continue;
    }
    specifiers.push(...fromImportSpecifiers(moduleName, names));
  }
  return [...new Set(specifiers)];
}

function fromImportSpecifiers(moduleName: string, importedNames: string): string[] {
  const separator = moduleName.endsWith('.') ? '' : '.';
  const submodules = importedNames.replace(/[()]/g, '').split(',')
    .map((name) => name.trim().split(/\s+/)[0])
    .filter((importedName) => importedName && importedName !== '*')
    .map((importedName) => `${moduleName}${separator}${importedName}`);
  return [moduleName, ...submodules];
}

function resolvePythonSpecifier(fromPath: string, specifier: string, knownPaths: Set<string>): string | null {
  let moduleName = specifier;
  let directory = '';
  if (specifier.startsWith('.')) {
    directory = path.posix.dirname(fromPath);
    let dotCount = 0;
    while (specifier[dotCount] === '.') dotCount++;
    for (let index = 1; index < dotCount; index++) {
      if (directory === '.') return null;
      directory = path.posix.dirname(directory);
    }
    moduleName = specifier.slice(dotCount);
  }
  const modulePath = path.posix.normalize(path.posix.join(directory, moduleName.replaceAll('.', '/')));
  if (modulePath === '..' || modulePath.startsWith('../') || path.posix.isAbsolute(modulePath)) return null;
  const candidates = moduleName ? [`${modulePath}.py`, `${modulePath}/__init__.py`] : [path.posix.join(directory, '__init__.py')];
  return candidates.find((candidate) => knownPaths.has(candidate)) ?? null;
}

function sourceCandidates(candidatePath: string): string[] {
  const mappedExtension: Record<string, string> = { '.js': '.ts', '.jsx': '.tsx', '.mjs': '.mts', '.cjs': '.cts' };
  const extension = path.posix.extname(candidatePath);
  const mapped = mappedExtension[extension];
  return [
    candidatePath,
    ...(mapped ? [`${candidatePath.slice(0, -extension.length)}${mapped}`] : []),
    `${candidatePath}.ts`, `${candidatePath}.js`, `${candidatePath}.mjs`, `${candidatePath}.cjs`,
    `${candidatePath}.tsx`, `${candidatePath}.jsx`, `${candidatePath}.mts`, `${candidatePath}.cts`,
    `${candidatePath}/index.ts`, `${candidatePath}/index.js`, `${candidatePath}/index.tsx`,
  ];
}

export function resolveSpecifier({
  fromPath,
  specifier,
  knownPaths,
  importsMap,
  tsconfigTargets = () => [],
}: {
  fromPath: string;
  specifier: string;
  knownPaths: Set<string>;
  importsMap: Record<string, string>;
  tsconfigTargets?: (fromPath: string, specifier: string) => string[];
}): string | null {
  if (fromPath.endsWith('.py')) return resolvePythonSpecifier(fromPath, specifier, knownPaths);
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  const aliasTargets = specifier.startsWith('#')
    ? matchPathPatterns(specifier, Object.fromEntries(Object.entries(importsMap).map(([alias, target]) => [alias, [target]])))
    : [];
  const targets = isRelative ? [path.posix.join(path.posix.dirname(fromPath), specifier)] : specifier.startsWith('#') ? aliasTargets : tsconfigTargets(fromPath, specifier);
  for (const target of targets) {
    const candidatePath = path.posix.normalize(target.replace(/^\.\//, ''));
    if (candidatePath.startsWith('../') || candidatePath === '..' || path.posix.isAbsolute(candidatePath)) continue;
    const found = sourceCandidates(candidatePath).find((candidate) => knownPaths.has(candidate));
    if (found) return found;
  }
  return null;
}

export function buildImportGraph({
  specifiersByPath,
  importsMap,
  tsconfigTargets,
}: {
  specifiersByPath: Map<string, string[]>;
  importsMap: Record<string, string>;
  tsconfigTargets?: (fromPath: string, specifier: string) => string[];
}): ImportGraph {
  const knownPaths = new Set(specifiersByPath.keys());
  const dependentsByPath = new Map(
    [...knownPaths].map((knownPath): [string, Set<string>] => [knownPath, new Set()]),
  );

  for (const [fromPath, specifiers] of specifiersByPath) {
    for (const specifier of specifiers) {
      const importedPath = resolveSpecifier({ fromPath, specifier, knownPaths, importsMap, tsconfigTargets });
      if (!importedPath) continue;
      dependentsByPath.get(importedPath)?.add(fromPath);
    }
  }

  return { dependentsByPath };
}

export function isTestPath(repoPath: string): boolean {
  const segments = repoPath.split('/');
  if (segments.slice(0, -1).some((segment) => segment === 'tests' || segment === 'test' || segment === '__tests__')) return true;
  const fileName = segments.at(-1) ?? '';
  if (fileName.endsWith('.py') && (fileName.startsWith('test_') || fileName.endsWith('_test.py') || fileName === 'conftest.py')) return true;
  return fileName.includes('.test.') || fileName.includes('.spec.');
}

function collectTransitiveDependents(graph: ImportGraph, changedPath: string, maxDepth: number): Set<string> {
  const visitedPaths = new Set([changedPath]);
  const queuedPaths = [{ repoPath: changedPath, depth: 0 }];

  for (let index = 0; index < queuedPaths.length; index++) {
    const { repoPath, depth } = queuedPaths[index];
    if (depth >= maxDepth) continue;
    for (const dependentPath of graph.dependentsByPath.get(repoPath) ?? []) {
      if (visitedPaths.has(dependentPath)) continue;
      visitedPaths.add(dependentPath);
      queuedPaths.push({ repoPath: dependentPath, depth: depth + 1 });
    }
  }

  visitedPaths.delete(changedPath);
  return visitedPaths;
}

function compareRepoPaths(leftPath: string, rightPath: string): number {
  if (leftPath < rightPath) return -1;
  if (leftPath > rightPath) return 1;
  return 0;
}

export function computeBlastRadius({
  repoName,
  graph,
  changedPaths,
  maxDepth = 6,
}: {
  repoName: string;
  graph: ImportGraph;
  changedPaths: string[];
  maxDepth?: number;
}): { blastRadius: BlastRadiusFact[]; untestedFiles: UntestedFileFact[] } {
  const blastRadius: BlastRadiusFact[] = [];
  const untestedFiles: UntestedFileFact[] = [];

  for (const changedPath of new Set(changedPaths)) {
    if (isTestPath(changedPath)) continue;
    const transitiveDependents = collectTransitiveDependents(graph, changedPath, maxDepth);
    const dependentTests = [...transitiveDependents].filter(isTestPath).sort();

    if (/\.(?:ts|js|mjs|tsx|jsx|cts|cjs|mts|py)$/.test(changedPath) && dependentTests.length === 0) {
      untestedFiles.push({ factId: changeMapFactId('untested', repoName, changedPath), path: changedPath });
    }

    const directDependents = graph.dependentsByPath.get(changedPath);
    if (!directDependents) continue;
    if (directDependents.size === 0 && dependentTests.length === 0) continue;

    blastRadius.push({
      factId: changeMapFactId('blast', repoName, changedPath),
      path: changedPath,
      directDependents: [...directDependents].sort().slice(0, CHANGE_MAP_LIST_CAP),
      directDependentCount: directDependents.size,
      transitiveDependentCount: transitiveDependents.size,
      dependentTests: dependentTests.slice(0, CHANGE_MAP_LIST_CAP),
      dependentTestCount: dependentTests.length,
    });
  }

  blastRadius.sort((left, right) => right.transitiveDependentCount - left.transitiveDependentCount || compareRepoPaths(left.path, right.path));
  untestedFiles.sort((left, right) => compareRepoPaths(left.path, right.path));
  return { blastRadius, untestedFiles };
}
