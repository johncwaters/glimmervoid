import path from 'node:path';
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

function resolveImportAlias(specifier: string, importsMap: Record<string, string>): string | null {
  const exactTarget = importsMap[specifier];
  if (exactTarget) return exactTarget;

  for (const [alias, target] of Object.entries(importsMap)) {
    const wildcardIndex = alias.indexOf('*');
    if (wildcardIndex < 0 || alias.indexOf('*', wildcardIndex + 1) >= 0) continue;
    const prefix = alias.slice(0, wildcardIndex);
    const suffix = alias.slice(wildcardIndex + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    if (specifier.length < prefix.length + suffix.length) continue;
    const wildcardValue = specifier.slice(prefix.length, specifier.length - suffix.length);
    return target.replace('*', wildcardValue);
  }

  return null;
}

export function resolveSpecifier({
  fromPath,
  specifier,
  knownPaths,
  importsMap,
}: {
  fromPath: string;
  specifier: string;
  knownPaths: Set<string>;
  importsMap: Record<string, string>;
}): string | null {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  const aliasTarget = specifier.startsWith('#') ? resolveImportAlias(specifier, importsMap) : null;
  if (!isRelative && !aliasTarget) return null;
  const candidatePath = isRelative
    ? path.posix.join(path.posix.dirname(fromPath), specifier)
    : path.posix.normalize((aliasTarget ?? '').replace(/^\.\//, ''));
  if (candidatePath.startsWith('../') || candidatePath === '..') {
    return null;
  }

  const candidates = [
    candidatePath,
    `${candidatePath}.ts`,
    `${candidatePath}.js`,
    `${candidatePath}.mjs`,
    `${candidatePath}.tsx`,
    `${candidatePath}/index.ts`,
    `${candidatePath}/index.js`,
  ];
  return candidates.find((candidate) => knownPaths.has(candidate)) ?? null;
}

export function buildImportGraph({
  specifiersByPath,
  importsMap,
}: {
  specifiersByPath: Map<string, string[]>;
  importsMap: Record<string, string>;
}): ImportGraph {
  const knownPaths = new Set(specifiersByPath.keys());
  const dependentsByPath = new Map(
    [...knownPaths].map((knownPath): [string, Set<string>] => [knownPath, new Set()]),
  );

  for (const [fromPath, specifiers] of specifiersByPath) {
    for (const specifier of specifiers) {
      const importedPath = resolveSpecifier({ fromPath, specifier, knownPaths, importsMap });
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

    if (/\.(?:ts|js|mjs|tsx)$/.test(changedPath) && dependentTests.length === 0) {
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
